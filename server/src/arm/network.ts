/**
 * Rete e DNS come in Azure: validazione di subnet, peering, regole NSG, route, load balancer e record DNS;
 * riferimenti inversi calcolati alla lettura (subnet ↔ NSG, tabella di route, gateway NAT; IP pubblici; peering);
 * record impliciti delle zone DNS (SOA e NS all'apice); blocco dell'eliminazione delle risorse in uso.
 */
import * as store from '../db/store.ts';
import { armError, type ArmCtx } from './context.ts';
import { loadResource, type ResInfo } from './generic.ts';
import { monitorBeforeWrite, MONITOR_TYPES } from './monitoring.ts';

const NET = 'microsoft.network/';
const T = {
  vnet: `${NET}virtualnetworks`,
  subnet: `${NET}virtualnetworks/subnets`,
  peering: `${NET}virtualnetworks/virtualnetworkpeerings`,
  nsg: `${NET}networksecuritygroups`,
  rule: `${NET}networksecuritygroups/securityrules`,
  rt: `${NET}routetables`,
  route: `${NET}routetables/routes`,
  nat: `${NET}natgateways`,
  pip: `${NET}publicipaddresses`,
  nic: `${NET}networkinterfaces`,
  lb: `${NET}loadbalancers`,
  dns: `${NET}dnszones`,
  pdns: `${NET}privatednszones`,
  link: `${NET}privatednszones/virtualnetworklinks`,
};
const low = (s?: string | null) => String(s ?? '').toLowerCase();
const idEq = (a?: string | null, b?: string | null) => !!a && !!b && low(a) === low(b);
const nameOf = (id: string) => id.split('/').pop() ?? id;
const isDnsRecord = (t: string) => (t.startsWith(`${T.dns}/`) || t.startsWith(`${T.pdns}/`)) && t !== T.link;

// ---------------- indirizzi ----------------

interface Range { lo: number; hi: number; text: string }

/** CIDR IPv4 → intervallo; null se non è IPv4. Lancia InvalidCIDRNotation se i bit host non sono a zero. */
export function cidr(text: string, where = ''): Range | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(text).trim());
  if (!m) {
    if (String(text).includes(':')) return null; // IPv6: accettato senza controlli di sovrapposizione
    throw armError(400, 'InvalidAddressPrefixFormat', `The address prefix ${text}${where} has an invalid format.`);
  }
  const oct = m.slice(1, 5).map(Number);
  const len = Number(m[5]);
  if (oct.some((o) => o > 255) || len > 32) throw armError(400, 'InvalidAddressPrefixFormat', `The address prefix ${text}${where} has an invalid format.`);
  const ip = ((oct[0] << 24) | (oct[1] << 16) | (oct[2] << 8) | oct[3]) >>> 0;
  const size = 2 ** (32 - len);
  const lo = len === 0 ? 0 : (ip - (ip % size)) >>> 0;
  if (lo !== ip) {
    const n = [lo >>> 24, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255].join('.');
    throw armError(400, 'InvalidCIDRNotation', `The address prefix ${text}${where} has an invalid CIDR notation. For the given prefix length, the address prefix should be ${n}/${len}.`);
  }
  return { lo, hi: lo + size - 1, text };
}
const overlap = (a: Range, b: Range) => a.lo <= b.hi && b.lo <= a.hi;
const inside = (a: Range, b: Range) => a.lo >= b.lo && a.hi <= b.hi;
const isIpv4 = (s: string) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((o) => Number(o) <= 255);
const prefixesOf = (p: any): string[] => (Array.isArray(p?.addressPrefixes) && p.addressPrefixes.length ? p.addressPrefixes : p?.addressPrefix ? [p.addressPrefix] : []);

// ---------------- letture con cache per richiesta ----------------

const cache = new WeakMap<ArmCtx, Map<string, Promise<any[]>>>();
/** Tutte le risorse di un tipo nella sottoscrizione (più quelle pianificate da un deployment in corso). */
function allOf(ctx: ArmCtx, sub: string | null | undefined, type: string): Promise<any[]> {
  let m = cache.get(ctx);
  if (!m) cache.set(ctx, (m = new Map()));
  const key = `${low(sub)}|${type}`;
  if (!m.has(key)) {
    m.set(key, (async () => {
      const recs: any[] = sub ? await store.list('resource', { prefix: `/subscriptions/${low(sub)}/`, match: { _type: type } }) : [];
      for (const r of ctx.plan?.values() ?? []) if (r._type === type && !recs.some((x) => idEq(x.id, r.id))) recs.push(r);
      return recs;
    })());
  }
  return m.get(key)!;
}
async function children(ctx: ArmCtx, parentId: string, type: string): Promise<any[]> {
  const kids: any[] = await store.list('resource', { parent: parentId, match: { _type: type } });
  const prefix = low(parentId) + '/';
  for (const [k, v] of ctx.plan ?? []) if (v._type === type && k.startsWith(prefix) && !kids.some((x) => low(x.id) === k)) kids.push(v);
  return kids;
}
const subOf = (id: string) => /^\/subscriptions\/([^/]+)/i.exec(id)?.[1];

/** Configurazioni IP delle NIC e frontend dei load balancer: chi usa subnet, IP pubblici e pool. */
async function ipConfigs(ctx: ArmCtx, sub?: string): Promise<{ id: string; owner: string; p: any }[]> {
  const out: { id: string; owner: string; p: any }[] = [];
  for (const nic of await allOf(ctx, sub, T.nic)) for (const ip of nic.properties?.ipConfigurations ?? []) out.push({ id: ip.id ?? `${nic.id}/ipConfigurations/${ip.name}`, owner: nic.id, p: { ...ip.properties, _nicNsg: nic.properties?.networkSecurityGroup?.id } });
  for (const lb of await allOf(ctx, sub, T.lb)) for (const fe of lb.properties?.frontendIPConfigurations ?? []) out.push({ id: fe.id ?? `${lb.id}/frontendIPConfigurations/${fe.name}`, owner: lb.id, p: fe.properties ?? {} });
  return out;
}

async function mustExist(ctx: ArmCtx, id: string | undefined, by: string, type?: string) {
  if (!id) return;
  const r = await loadResource(ctx, id);
  if (!r || (type && r._type !== type)) throw armError(400, 'InvalidResourceReference', `Resource ${id} referenced by resource ${by} was not found. Please make sure that the referenced resource exists, and that both resources are in the same region.`);
}

// ---------------- validazioni ----------------

async function checkSubnetProps(ctx: ArmCtx, subnetId: string, props: any) {
  delete props.ipConfigurations; // calcolati alla lettura
  delete props.ipConfigurationProfiles;
  await mustExist(ctx, props?.networkSecurityGroup?.id, subnetId, T.nsg);
  await mustExist(ctx, props?.routeTable?.id, subnetId, T.rt);
  await mustExist(ctx, props?.natGateway?.id, subnetId, T.nat);
  props.delegations = (props.delegations ?? []).map((d: any, i: number) => {
    const name = d.name ?? `delegation${i}`;
    if (!d.properties?.serviceName) throw armError(400, 'InvalidRequestFormat', `Delegation ${name} of subnet ${subnetId} must specify properties.serviceName.`);
    return { name, id: `${subnetId}/delegations/${name}`, type: 'Microsoft.Network/virtualNetworks/subnets/delegations', properties: { serviceName: d.properties.serviceName, actions: d.properties.actions ?? ['Microsoft.Network/virtualNetworks/subnets/action'], provisioningState: 'Succeeded' } };
  });
  props.serviceEndpoints = (props.serviceEndpoints ?? []).map((s: any) => {
    if (!/^Microsoft\.[A-Za-z]+$/.test(String(s.service ?? ''))) throw armError(400, 'InvalidServiceNameOnServiceEndpoint', `Service name ${s.service} on the service endpoint of subnet ${subnetId} is not valid.`);
    return { service: s.service, locations: s.locations ?? ['*'], provisioningState: 'Succeeded' };
  });
}

/** Le subnet devono stare nello spazio di indirizzi della rete e non sovrapporsi tra loro. */
function checkSubnetLayout(vnet: any, subnets: { name: string; prefixes: string[] }[]) {
  const space = (vnet.properties?.addressSpace?.addressPrefixes ?? []).map((p: string) => cidr(p)).filter(Boolean) as Range[];
  const seen: { name: string; r: Range }[] = [];
  for (const s of subnets) {
    if (!s.prefixes.length) throw armError(400, 'InvalidRequestFormat', `Subnet '${s.name}' must specify properties.addressPrefix.`);
    for (const p of s.prefixes) {
      const r = cidr(p, ` of subnet '${s.name}'`);
      if (!r) continue;
      if (r.hi - r.lo + 1 < 8) throw armError(400, 'InvalidAddressPrefix', `Subnet '${s.name}' has the address prefix ${p}: the smallest supported subnet is /29.`);
      if (!space.some((v) => inside(r, v))) throw armError(400, 'NetcfgSubnetRangeOutsideVnet', `Subnet '${s.name}' is not valid because its IP address range is outside the IP address range of virtual network '${vnet.name}'.`);
      const clash = seen.find((x) => x.name !== s.name && overlap(x.r, r));
      if (clash) throw armError(400, 'NetcfgSubnetRangesOverlap', `Subnet '${s.name}' is not valid in virtual network '${vnet.name}' because its IP address range overlaps with that of an existing subnet '${clash.name}'.`);
      seen.push({ name: s.name, r });
    }
  }
}

async function subnetUsers(ctx: ArmCtx, subnetId: string): Promise<string[]> {
  return (await ipConfigs(ctx, subOf(subnetId))).filter((c) => idEq(c.p.subnet?.id, subnetId)).map((c) => c.id);
}

const PORT = /^(\*|\d{1,5}(-\d{1,5})?)$/;
function checkPortRange(v: string, rule: string) {
  const ok = PORT.test(v) && (v === '*' || v.split('-').every((n) => Number(n) <= 65535)) && (!v.includes('-') || Number(v.split('-')[0]) <= Number(v.split('-')[1]));
  if (!ok) throw armError(400, 'SecurityRuleInvalidPortRange', `Security rule ${rule} has invalid Port range. Value provided: ${v}. Value should be an integer OR integer range with '-' delimiter. Valid range 0-65535.`);
}
const ADDR = (s: string) => s === '*' || isIpv4(s) || /^[0-9a-fA-F:.]+\/\d{1,3}$/.test(s) || /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)?$/.test(s);
function checkRule(name: string, p: any) {
  const pr = Number(p?.priority);
  if (!Number.isInteger(pr) || pr < 100 || pr > 4096) throw armError(400, 'SecurityRuleInvalidPriority', `Security rule ${name} has invalid Priority. Value provided: ${p?.priority} Allowed range 100-4096.`);
  if (!['Inbound', 'Outbound'].includes(p?.direction)) throw armError(400, 'SecurityRuleInvalidDirection', `Security rule ${name} has invalid Direction. Value provided: ${p?.direction}. Allowed values: Inbound, Outbound.`);
  if (!['Allow', 'Deny'].includes(p?.access)) throw armError(400, 'SecurityRuleInvalidAccess', `Security rule ${name} has invalid Access. Value provided: ${p?.access}. Allowed values: Allow, Deny.`);
  if (!['Tcp', 'Udp', 'Icmp', 'Esp', 'Ah', '*'].includes(p?.protocol)) throw armError(400, 'SecurityRuleInvalidProtocol', `Security rule ${name} has invalid Protocol. Value provided: ${p?.protocol}.`);
  for (const k of ['sourcePortRange', 'destinationPortRange'] as const) {
    const many: string[] = p[`${k}s`] ?? [];
    if (!p[k] && !many.length) throw armError(400, 'SecurityRuleParameterMissing', `Security rule ${name} must specify ${k} or ${k}s.`);
    for (const v of p[k] ? [p[k]] : many) checkPortRange(String(v), name);
  }
  for (const k of ['sourceAddressPrefix', 'destinationAddressPrefix'] as const) {
    const many: string[] = p[k.replace('Prefix', 'Prefixes')] ?? [];
    const asg = k === 'sourceAddressPrefix' ? p.sourceApplicationSecurityGroups : p.destinationApplicationSecurityGroups;
    if (!p[k] && !many.length && !asg?.length) throw armError(400, 'SecurityRuleParameterMissing', `Security rule ${name} must specify ${k} or ${k.replace('Prefix', 'Prefixes')}.`);
    for (const v of p[k] ? [p[k]] : many) if (!ADDR(String(v))) throw armError(400, 'SecurityRuleInvalidAddressPrefix', `Security rule ${name} has invalid Address prefix. Value provided: ${v}.`);
  }
}
function checkRulePriorities(rules: { name: string; p: any }[]) {
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i], b = rules[j];
    if (Number(a.p.priority) === Number(b.p.priority) && a.p.direction === b.p.direction) {
      throw armError(400, 'SecurityRuleConflict', `Security rule ${b.name} conflicts with rule ${a.name}. Rules cannot have the same Priority and Direction. To learn more, see aka.ms/nsgrules.`);
    }
  }
}

const HOPS = ['VirtualNetworkGateway', 'VnetLocal', 'Internet', 'VirtualAppliance', 'None'];
function checkRoute(name: string, p: any) {
  const prefix = String(p?.addressPrefix ?? '');
  if (!prefix) throw armError(400, 'InvalidRequestFormat', `Route ${name} must specify properties.addressPrefix.`);
  if (prefix.includes('/')) cidr(prefix, ` of route '${name}'`);
  else if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(prefix)) throw armError(400, 'InvalidAddressPrefixFormat', `The address prefix ${prefix} of route '${name}' has an invalid format.`);
  if (!HOPS.includes(p?.nextHopType)) throw armError(400, 'InvalidNextHopType', `Route ${name} has invalid next hop type ${p?.nextHopType}. Allowed values: ${HOPS.join(', ')}.`);
  if (p.nextHopType === 'VirtualAppliance' && !isIpv4(String(p.nextHopIpAddress ?? ''))) throw armError(400, 'InvalidNextHopIpAddress', `Route ${name} has next hop type VirtualAppliance and must specify a valid nextHopIpAddress.`);
  if (p.nextHopType !== 'VirtualAppliance' && p.nextHopIpAddress) throw armError(400, 'NextHopIpAddressNotAllowed', `Route ${name}: nextHopIpAddress is allowed only when the next hop type is VirtualAppliance.`);
}

const LB_PARTS = ['frontendIPConfigurations', 'backendAddressPools', 'loadBalancingRules', 'probes', 'inboundNatRules', 'outboundRules'];
async function shapeLoadBalancer(ctx: ArmCtx, rec: any) {
  const P = rec.properties;
  for (const part of LB_PARTS) {
    P[part] = (P[part] ?? []).map((x: any) => {
      if (!x?.name) throw armError(400, 'InvalidRequestFormat', `Each item in '${part}' must have a name.`);
      return { ...x, id: `${rec.id}/${part}/${x.name}`, type: `Microsoft.Network/loadBalancers/${part}`, etag: `W/"${crypto.randomUUID()}"`, properties: { ...(x.properties ?? {}), provisioningState: 'Succeeded' } };
    });
  }
  const has = (part: string, id?: string) => !!id && P[part].some((x: any) => idEq(x.id, id));
  for (const fe of P.frontendIPConfigurations) {
    await mustExist(ctx, fe.properties.publicIPAddress?.id, fe.id, T.pip);
    await mustExist(ctx, fe.properties.subnet?.id, fe.id, T.subnet);
    if (!fe.properties.publicIPAddress?.id && !fe.properties.subnet?.id) throw armError(400, 'InvalidRequestFormat', `Frontend IP configuration ${fe.name} must reference a public IP address or a subnet.`);
  }
  const ruleKey = new Map<string, string>();
  for (const r of P.loadBalancingRules) {
    const p = r.properties;
    if (!has('frontendIPConfigurations', p.frontendIPConfiguration?.id)) throw armError(400, 'InvalidResourceReference', `Resource ${p.frontendIPConfiguration?.id ?? '(none)'} referenced by resource ${r.id} was not found.`);
    if (p.backendAddressPool?.id && !has('backendAddressPools', p.backendAddressPool.id)) throw armError(400, 'InvalidResourceReference', `Resource ${p.backendAddressPool.id} referenced by resource ${r.id} was not found.`);
    if (p.probe?.id && !has('probes', p.probe.id)) throw armError(400, 'InvalidResourceReference', `Resource ${p.probe.id} referenced by resource ${r.id} was not found.`);
    if (!['Tcp', 'Udp', 'All'].includes(p.protocol)) throw armError(400, 'InvalidRequestFormat', `Load balancing rule ${r.name} has invalid protocol ${p.protocol}.`);
    for (const k of ['frontendPort', 'backendPort']) if (!Number.isInteger(Number(p[k])) || Number(p[k]) < 0 || Number(p[k]) > 65535) throw armError(400, 'InvalidRequestFormat', `Load balancing rule ${r.name} has invalid ${k} ${p[k]}. Valid range 0-65535.`);
    const key = `${low(p.frontendIPConfiguration.id)}|${p.protocol}|${p.frontendPort}`;
    if (ruleKey.has(key)) throw armError(400, 'RulesUseSameFrontendIpAndPort', `Load balancing rules ${ruleKey.get(key)} and ${r.name} use the same frontend IP configuration, protocol and frontend port ${p.frontendPort}.`);
    ruleKey.set(key, r.name);
    p.idleTimeoutInMinutes ??= 4;
    p.enableFloatingIP ??= false;
    p.loadDistribution ??= 'Default';
  }
  for (const pr of P.probes) {
    const p = pr.properties;
    if (!['Tcp', 'Http', 'Https'].includes(p.protocol)) throw armError(400, 'InvalidRequestFormat', `Probe ${pr.name} has invalid protocol ${p.protocol}.`);
    if (p.protocol !== 'Tcp' && !p.requestPath) throw armError(400, 'ProbeRequestPathMissing', `Probe ${pr.name} uses ${p.protocol} and must specify requestPath.`);
    if (p.protocol === 'Tcp' && p.requestPath) throw armError(400, 'InvalidRequestFormat', `Probe ${pr.name} uses Tcp and cannot specify requestPath.`);
    p.intervalInSeconds ??= 5;
    p.numberOfProbes ??= 1;
    p.probeThreshold ??= 1;
  }
  const users = (part: string, id: string) => P.loadBalancingRules.filter((r: any) => idEq(r.properties[part]?.id, id)).map((r: any) => ({ id: r.id }));
  for (const fe of P.frontendIPConfigurations) fe.properties.loadBalancingRules = users('frontendIPConfiguration', fe.id);
  for (const bp of P.backendAddressPools) bp.properties.loadBalancingRules = users('backendAddressPool', bp.id);
  for (const pr of P.probes) pr.properties.loadBalancingRules = users('probe', pr.id);
}

const DNS_ARRAYS: Record<string, string[]> = { a: ['ARecords', 'aRecords'], aaaa: ['AAAARecords', 'aaaaRecords'], mx: ['MXRecords', 'mxRecords'], ns: ['NSRecords', 'nsRecords'], ptr: ['PTRRecords', 'ptrRecords'], srv: ['SRVRecords', 'srvRecords'], txt: ['TXTRecords', 'txtRecords'], caa: ['CAARecords', 'caaRecords'], cname: ['CNAMERecord', 'cnameRecord'], soa: ['SOARecord', 'soaRecord'] };
async function checkDnsRecord(ctx: ArmCtx, info: ResInfo, rec: any) {
  const kind = low(nameOf(rec.type));
  const name = rec.name;
  const zoneId = info.parentId!;
  const P = rec.properties;
  const pick = (k: string) => DNS_ARRAYS[k].map((x) => P[x]).find((v) => v !== undefined);
  if (kind === 'soa' && name !== '@') throw armError(400, 'BadRequest', 'The SOA record set can exist only at the zone apex (@).');
  if (kind === 'cname' && name === '@') throw armError(400, 'BadRequest', "A record set of type 'CNAME' cannot be created at the zone apex. Use an alias record set instead.");
  if (P.TTL === undefined && P.ttl === undefined) P[info.type.startsWith('Microsoft.Network/privateDnsZones') ? 'ttl' : 'TTL'] = 3600;
  const ttl = Number(P.TTL ?? P.ttl);
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 2147483647) throw armError(400, 'BadRequest', `The TTL ${P.TTL ?? P.ttl} of record set '${name}' is not valid.`);
  const rows: any[] = (kind === 'cname' || kind === 'soa' ? [pick(kind)].filter(Boolean) : pick(kind) ?? []);
  for (const r of rows) {
    const ok =
      kind === 'a' ? isIpv4(String(r.ipv4Address ?? '')) :
      kind === 'aaaa' ? /^[0-9a-fA-F:]+$/.test(String(r.ipv6Address ?? '')) && String(r.ipv6Address).includes(':') :
      kind === 'mx' ? Number.isInteger(Number(r.preference)) && !!r.exchange :
      kind === 'srv' ? ['priority', 'weight', 'port'].every((k) => Number.isInteger(Number(r[k]))) && !!r.target :
      kind === 'caa' ? ['issue', 'issuewild', 'iodef'].includes(String(r.tag)) && r.value !== undefined :
      kind === 'txt' ? Array.isArray(r.value) && r.value.every((v: any) => typeof v === 'string' && v.length <= 1024) :
      kind === 'ns' ? !!r.nsdname : kind === 'ptr' ? !!r.ptrdname : kind === 'cname' ? !!r.cname : true;
    if (!ok) throw armError(400, 'BadRequest', `The ${kind.toUpperCase()} record ${JSON.stringify(r)} in record set '${name}' is not valid.`);
  }
  // un CNAME non può convivere con altri record con lo stesso nome
  const siblings = (await store.list('resource', { parent: zoneId })).filter((x: any) => isDnsRecord(x._type) && x.name === name && !idEq(x.id, rec.id));
  if (kind === 'cname' && siblings.length) throw armError(409, 'Conflict', `A record set of type 'CNAME' with name '${name}' cannot be created because a record set with the same name and a different type already exists.`);
  if (kind !== 'cname' && siblings.some((x: any) => x._type.endsWith('/cname'))) throw armError(409, 'Conflict', `A record set of type '${kind.toUpperCase()}' with name '${name}' cannot be created because a CNAME record set with the same name already exists.`);
}

// ---------------- punti di aggancio ----------------

const WRITE_TYPES = new Set([T.vnet, T.subnet, T.peering, T.nsg, T.rule, T.rt, T.route, T.lb, T.link, ...MONITOR_TYPES]);

/** Prima di salvare: validazioni e forma delle sotto-risorse. `inline` sono i figli inviati nel corpo (subnet, regole, route). */
export async function beforeWrite(ctx: ArmCtx, info: ResInfo, rec: any, existing: any, inline: { type: string; items: any[] }[]): Promise<void> {
  const t = rec._type as string;
  cache.delete(ctx);
  // riferimenti inversi: Azure li calcola, chi rimanda indietro il GET non deve poterli salvare
  if (t === T.nsg) { delete rec.properties.subnets; delete rec.properties.networkInterfaces; }
  if (t === T.rt || t === T.nat) delete rec.properties.subnets;
  if (t === T.pip) delete rec.properties.ipConfiguration;
  if (t === T.peering) { delete rec.properties.peeringState; delete rec.properties.peeringSyncLevel; }
  if (isDnsRecord(t)) return checkDnsRecord(ctx, info, rec);
  if (!WRITE_TYPES.has(t)) return;
  if (MONITOR_TYPES.has(t)) return monitorBeforeWrite(ctx, info, rec);
  const P = rec.properties;
  const items = (type: string) => inline.find((x) => low(x.type) === type)?.items;

  if (t === T.vnet) {
    for (const p of P.addressSpace?.addressPrefixes ?? []) cidr(p, ` of virtual network '${rec.name}'`);
    const spaces = (P.addressSpace?.addressPrefixes ?? []).map((p: string) => cidr(p)).filter(Boolean) as Range[];
    for (let i = 0; i < spaces.length; i++) for (let j = i + 1; j < spaces.length; j++) if (overlap(spaces[i], spaces[j])) throw armError(400, 'VnetAddressSpaceOverlap', `Address prefixes ${spaces[i].text} and ${spaces[j].text} of virtual network '${rec.name}' overlap.`);
    for (const d of P.dhcpOptions?.dnsServers ?? []) if (!isIpv4(String(d))) throw armError(400, 'InvalidDnsServer', `DNS server ${d} of virtual network '${rec.name}' is not a valid IPv4 address.`);
    const sent = items('subnets');
    const stored = await children(ctx, rec.id, T.subnet);
    const subnets = sent ? sent.map((s: any) => ({ name: s.name, prefixes: prefixesOf(s.properties) })) : stored.map((s) => ({ name: s.name, prefixes: prefixesOf(s.properties) }));
    checkSubnetLayout(rec, subnets);
    for (const s of sent ?? []) { s.properties ??= {}; await checkSubnetProps(ctx, `${rec.id}/subnets/${s.name}`, s.properties); }
    if (sent) {
      for (const old of stored.filter((o) => !sent.some((s: any) => low(s.name) === low(o.name)))) {
        const used = await subnetUsers(ctx, old.id);
        if (used.length) throw armError(400, 'InUseSubnetCannotBeDeleted', `Subnet ${old.name} is in use by ${used[0]} and cannot be deleted. In order to delete the subnet, delete all the resources within the subnet. See aka.ms/deletesubnet.`);
      }
    }
    return;
  }
  if (t === T.subnet) {
    const vnet = await loadResource(ctx, info.parentId!);
    if (vnet) {
      const siblings = (await children(ctx, vnet.id, T.subnet)).filter((s) => !idEq(s.id, rec.id));
      checkSubnetLayout(vnet, [...siblings.map((s) => ({ name: s.name, prefixes: prefixesOf(s.properties) })), { name: rec.name, prefixes: prefixesOf(P) }]);
    }
    await checkSubnetProps(ctx, rec.id, P);
    if (existing && JSON.stringify(prefixesOf(existing.properties)) !== JSON.stringify(prefixesOf(P))) {
      const used = await subnetUsers(ctx, rec.id);
      if (used.length) throw armError(400, 'InUseSubnetCannotBeUpdated', `Subnet ${rec.name} is in use by ${used[0]} and its address prefix cannot be changed.`);
    }
    return;
  }
  if (t === T.peering) {
    const remoteId: string | undefined = P.remoteVirtualNetwork?.id;
    if (!remoteId) throw armError(400, 'InvalidRequestFormat', `Peering ${rec.name} must specify properties.remoteVirtualNetwork.id.`);
    if (idEq(remoteId, info.parentId)) throw armError(400, 'CannotPeerVnetWithItself', `Virtual network ${nameOf(remoteId)} cannot be peered with itself.`);
    const local = await loadResource(ctx, info.parentId!);
    const remote = await loadResource(ctx, remoteId);
    if (!remote || remote._type !== T.vnet) throw armError(400, 'ReferencedResourceNotProvisioned', `Cannot proceed with operation because resource ${remoteId} used by resource ${rec.id} is not found or not in Succeeded state.`);
    const dup = (await children(ctx, info.parentId!, T.peering)).find((x) => !idEq(x.id, rec.id) && idEq(x.properties?.remoteVirtualNetwork?.id, remoteId));
    if (dup) throw armError(400, 'VnetPeeringAlreadyExists', `Virtual network ${local?.name} already has peering ${dup.name} to virtual network ${remote.name}.`);
    const a = (local?.properties?.addressSpace?.addressPrefixes ?? []).map((p: string) => cidr(p)).filter(Boolean) as Range[];
    const b = (remote.properties?.addressSpace?.addressPrefixes ?? []).map((p: string) => cidr(p)).filter(Boolean) as Range[];
    const clash = a.flatMap((x) => b.filter((y) => overlap(x, y)).map((y) => `${x.text}, ${y.text}`));
    if (clash.length) throw armError(400, 'VnetAddressSpacesOverlap', `Cannot create or update peering ${rec.id}. Virtual networks ${info.parentId} and ${remoteId} cannot be peered because their address spaces overlap. Overlapping address prefixes: ${clash.join('; ')}`);
    P.allowVirtualNetworkAccess ??= true;
    P.allowForwardedTraffic ??= false;
    P.allowGatewayTransit ??= false;
    P.useRemoteGateways ??= false;
    P.remoteAddressSpace = { addressPrefixes: remote.properties?.addressSpace?.addressPrefixes ?? [] };
    P.remoteVirtualNetworkAddressSpace = P.remoteAddressSpace;
    return;
  }
  if (t === T.nsg) {
    const rules = items('securityrules');
    if (rules) {
      for (const r of rules) checkRule(r.name, r.properties ?? {});
      checkRulePriorities(rules.map((r: any) => ({ name: r.name, p: r.properties })));
    }
    return;
  }
  if (t === T.rule) {
    checkRule(rec.name, P);
    const siblings = (await children(ctx, info.parentId!, T.rule)).filter((s) => !idEq(s.id, rec.id));
    checkRulePriorities([...siblings.map((s) => ({ name: s.name, p: s.properties })), { name: rec.name, p: P }]);
    return;
  }
  if (t === T.rt) {
    for (const r of items('routes') ?? []) checkRoute(r.name, r.properties ?? {});
    return;
  }
  if (t === T.route) return checkRoute(rec.name, P);
  if (t === T.lb) return shapeLoadBalancer(ctx, rec);
  if (t === T.link) {
    const vnetId: string | undefined = P.virtualNetwork?.id;
    const vnet = vnetId ? await loadResource(ctx, vnetId) : null;
    if (!vnet || vnet._type !== T.vnet) throw armError(400, 'BadRequest', `The virtual network ${vnetId ?? '(none)'} referenced by link ${rec.name} does not exist.`);
    const same = (await children(ctx, info.parentId!, T.link)).find((l) => !idEq(l.id, rec.id) && idEq(l.properties?.virtualNetwork?.id, vnetId));
    if (same) throw armError(409, 'Conflict', `A virtual network link to virtual network ${vnet.name} already exists in this zone (${same.name}).`);
    P.registrationEnabled = !!P.registrationEnabled;
    if (P.registrationEnabled) {
      const others = (await allOf(ctx, subOf(rec.id), T.link)).filter((l) => !idEq(l.id, rec.id) && l.properties?.registrationEnabled && idEq(l.properties?.virtualNetwork?.id, vnetId));
      if (others.length) throw armError(409, 'Conflict', `Virtual network ${vnet.name} already has auto-registration enabled with another private DNS zone (${others[0].id.split('/privateDnsZones/')[1]?.split('/')[0]}). A virtual network can auto-register in one private DNS zone only.`);
    }
    P.virtualNetworkLinkState = 'Completed';
    P.provisioningState = 'Succeeded';
  }
}

/** Record SOA e NS impliciti che Azure crea con la zona. */
export function implicitAfterCreate(rec: any, created: boolean): [string, any, string][] {
  if (!created) return [];
  if (rec._type === T.dns) {
    const ns: string[] = rec.properties?.nameServers ?? [];
    return [
      [`${rec.id}/NS/@`, { properties: { TTL: 172800, NSRecords: ns.map((n) => ({ nsdname: n })) } }, '2018-05-01'],
      [`${rec.id}/SOA/@`, { properties: { TTL: 3600, SOARecord: { host: ns[0] ?? 'ns1-01.azure-dns.com.', email: 'azuredns-hostmaster.microsoft.com', serialNumber: 1, refreshTime: 3600, retryTime: 300, expireTime: 2419200, minimumTTL: 300 } } }, '2018-05-01'],
    ];
  }
  if (rec._type === T.pdns) {
    return [[`${rec.id}/SOA/@`, { properties: { ttl: 3600, soaRecord: { host: 'azureprivatedns.net', email: 'azureprivatedns-host.microsoft.com', serialNumber: 1, refreshTime: 3600, retryTime: 300, expireTime: 2419200, minimumTtl: 10 } } }, '2020-06-01']];
  }
  return [];
}

/** Azure rifiuta l'eliminazione di ciò che è ancora in uso. */
export async function beforeDelete(ctx: ArmCtx, existing: any): Promise<void> {
  const t = existing._type as string;
  const sub = subOf(existing.id);
  if (t === T.subnet || t === T.vnet) {
    const subnets = t === T.subnet ? [existing] : await children(ctx, existing.id, T.subnet);
    for (const s of subnets) {
      const used = await subnetUsers(ctx, s.id);
      if (used.length) throw armError(400, 'InUseSubnetCannotBeDeleted', `Subnet ${s.name} is in use by ${used[0]} and cannot be deleted. In order to delete the subnet, delete all the resources within the subnet. See aka.ms/deletesubnet.`);
    }
    return;
  }
  const usedBy = async (key: 'networkSecurityGroup' | 'routeTable' | 'natGateway') => [
    ...(await allOf(ctx, sub, T.subnet)).filter((s) => idEq(s.properties?.[key]?.id, existing.id)).map((s) => s.id),
    ...(key === 'networkSecurityGroup' ? (await allOf(ctx, sub, T.nic)).filter((n) => idEq(n.properties?.networkSecurityGroup?.id, existing.id)).map((n) => n.id) : []),
  ];
  const deny = (code: string, what: string, users: string[]) => { if (users.length) throw armError(400, code, `${what} ${existing.id} cannot be deleted because it is in use by the following resources: ${users.join(', ')}. In order to delete it, remove the association first.`); };
  if (t === T.nsg) return deny('InUseNetworkSecurityGroupCannotBeDeleted', 'Network security group', await usedBy('networkSecurityGroup'));
  if (t === T.rt) return deny('InUseRouteTableCannotBeDeleted', 'Route table', await usedBy('routeTable'));
  if (t === T.nat) return deny('InUseNatGatewayCannotBeDeleted', 'NAT gateway', await usedBy('natGateway'));
  if (t === T.pip) {
    const user = (await ipConfigs(ctx, sub)).find((c) => idEq(c.p.publicIPAddress?.id, existing.id));
    if (user) throw armError(400, 'PublicIPAddressCannotBeDeleted', `Public IP address ${existing.id} can not be deleted since it is still allocated to resource ${user.id}. In order to delete the public IP, disassociate/detach the Public IP address from the resource.`);
    return;
  }
  if (isDnsRecord(t) && existing.name === '@') {
    if (t.endsWith('/soa')) throw armError(400, 'BadRequest', 'The SOA record set at the zone apex cannot be deleted.');
    if (t === `${T.dns}/ns`) throw armError(400, 'BadRequest', 'The NS record set at the zone apex cannot be deleted.');
  }
}

/** Alla lettura: riferimenti inversi e contatori che Azure calcola. */
export async function decorate(ctx: ArmCtx, rec: any, out: any): Promise<void> {
  const t = rec._type as string;
  if (![T.nsg, T.rt, T.nat, T.subnet, T.pip, T.peering, T.lb, T.dns, T.pdns].includes(t)) return;
  const sub = subOf(rec.id);
  const P = (out.properties ??= {});
  const refs = (ids: string[]) => ids.map((id) => ({ id }));
  if (t === T.nsg || t === T.rt || t === T.nat) {
    const key = t === T.nsg ? 'networkSecurityGroup' : t === T.rt ? 'routeTable' : 'natGateway';
    P.subnets = refs((await allOf(ctx, sub, T.subnet)).filter((s) => idEq(s.properties?.[key]?.id, rec.id)).map((s) => s.id));
    if (t === T.nsg) P.networkInterfaces = refs((await allOf(ctx, sub, T.nic)).filter((n) => idEq(n.properties?.networkSecurityGroup?.id, rec.id)).map((n) => n.id));
  } else if (t === T.subnet) {
    const used = await subnetUsers(ctx, rec.id);
    if (used.length) P.ipConfigurations = refs(used);
    else delete P.ipConfigurations;
  } else if (t === T.pip) {
    const user = (await ipConfigs(ctx, sub)).find((c) => idEq(c.p.publicIPAddress?.id, rec.id));
    if (user) P.ipConfiguration = { id: user.id };
    else delete P.ipConfiguration;
  } else if (t === T.peering) {
    const remote = await loadResource(ctx, P.remoteVirtualNetwork?.id ?? '');
    const back = remote ? (await children(ctx, remote.id, T.peering)).some((x) => idEq(x.properties?.remoteVirtualNetwork?.id, rec.id.split('/virtualNetworkPeerings/')[0])) : false;
    P.peeringState = !remote ? 'Disconnected' : back ? 'Connected' : 'Initiated';
    P.peeringSyncLevel = back ? 'FullyInSync' : 'RemoteNotInSync';
    if (remote) P.remoteAddressSpace = { addressPrefixes: remote.properties?.addressSpace?.addressPrefixes ?? [] };
  } else if (t === T.lb) {
    const nics = await allOf(ctx, sub, T.nic);
    for (const bp of P.backendAddressPools ?? []) {
      bp.properties ??= {};
      bp.properties.backendIPConfigurations = refs(nics.flatMap((n) => (n.properties?.ipConfigurations ?? []).filter((ip: any) => (ip.properties?.loadBalancerBackendAddressPools ?? []).some((x: any) => idEq(x.id, bp.id))).map((ip: any) => ip.id ?? `${n.id}/ipConfigurations/${ip.name}`)));
    }
  } else if (t === T.dns || t === T.pdns) {
    const kids = await store.list('resource', { parent: rec.id });
    P.numberOfRecordSets = kids.filter((k: any) => isDnsRecord(k._type)).length;
    if (t === T.pdns) {
      const links = kids.filter((k: any) => k._type === T.link);
      P.numberOfVirtualNetworkLinks = links.length;
      P.numberOfVirtualNetworkLinksWithRegistration = links.filter((l: any) => l.properties?.registrationEnabled).length;
    }
  }
}

/** GET {zona}/recordsets e {zona}/all: tutti i record set della zona, di ogni tipo. */
export async function listRecordSets(zoneId: string): Promise<any[]> {
  return (await store.list('resource', { parent: zoneId })).filter((k: any) => isDnsRecord(k._type));
}
