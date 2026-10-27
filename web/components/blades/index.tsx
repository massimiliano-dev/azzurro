'use client';

import type { ReactNode } from 'react';
import { WebAppConfig, WebAppDomains, WebAppSecurity } from './webapp';
import { PlanScale, WebAppPlan } from './plan';
import { DbConnect, DbDatabases, DbKind, DbNetworking, DbParams, dbKind } from './database';
import { CosmosExplorer, StorageData } from './data';
import { useL } from './common';
import { RedisConnect, RedisFirewall, RedisScale, RedisSettings } from './redis';
import { VmDisks, VmNetworking, VmSize } from './compute';
import { AcrAccess, AcrSku, AcrWebhooks, AksPools, AksUpgrade, CaContainers, CaIngress, CaRevisions, CaScale, CaSecrets } from './containers';
import { EhEntities, MsgPolicies, SbEntities, msgKind } from './messaging';
import { AppConfigKeys, AppConfigValues } from './appconfig';
import { AppInsightsSettings, LawSettings } from './monitor';
import { AiDeployments, AiKeys, AiNetworking, AiProjects, supportsDeployments } from './ai';
import { VaultAccess, VaultKeys, VaultNetworking } from './keyvault';
import { StorageConfig, StorageLifecycle, StorageNetworking, StorageSas } from './storage';
import { SwaDomains, SwaPlan, SwaSettings } from './staticsite';
import { SearchKeys, SearchScale, SignalRKeys, SignalRScale } from './search';
import { NatGatewaySettings, NsgRulesEditor, LoadBalancerConfig, PublicIpSettings, RouteTableRoutes, SubnetAssociations, VnetAddressSpace, VnetPeerings, VnetSubnets } from './network';
import { DnsRecordSets, PrivateDnsLinks } from './dns';

export interface ServiceTab { key: string; label: string; render: () => ReactNode }

/** Schede di servizio specifiche per tipo di risorsa (come i pannelli del portale Azure). */
export function useServiceTabs(type: string | undefined, id: string, r: any, reload: () => void, apiVersion = '2024-03-01'): ServiceTab[] {
  const L = useL();
  if (!type || !r) return [];
  const t = type.toLowerCase();
  if (t === 'microsoft.web/sites' || t === 'microsoft.web/sites/slots') {
    return [
      { key: 'config', label: L('Configurazione', 'Configuration'), render: () => <WebAppConfig id={id} /> },
      { key: 'plan', label: L('Piano e scalabilità', 'Plan and scale'), render: () => <WebAppPlan id={id} site={r} reload={reload} /> },
      { key: 'domains', label: L('Domini personalizzati', 'Custom domains'), render: () => <WebAppDomains id={id} site={r} reload={reload} /> },
      { key: 'security', label: L('Sicurezza e autenticazione', 'Security and authentication'), render: () => <WebAppSecurity id={id} site={r} reload={reload} /> },
    ];
  }
  if (t === 'microsoft.web/serverfarms') return [{ key: 'scale', label: L('Piano e scalabilità', 'Plan and scale'), render: () => <PlanScale planId={id} onChanged={reload} /> }];
  const k = dbKind(type);
  if (k) {
    return [
      { key: 'databases', label: L('Database', 'Databases'), render: () => <DbDatabases serverId={id} server={r} kind={k} /> },
      ...(k !== 'sql' ? [{ key: 'params', label: L('Parametri del server', 'Server parameters'), render: () => <DbParams serverId={id} kind={k} /> }] : []),
      { key: 'network', label: L('Rete', 'Networking'), render: () => <DbNetworking serverId={id} server={r} kind={k} reload={reload} /> },
      { key: 'connect', label: L('Stringhe di connessione', 'Connection strings'), render: () => <DbConnect server={r} kind={k} /> },
    ];
  }
  if (t === 'microsoft.sql/servers/databases') {
    const serverId = id.split('/databases/')[0];
    return [{ key: 'connect', label: L('Stringhe di connessione', 'Connection strings'), render: () => <ServerConnect serverId={serverId} kind="sql" database={r.name} /> }];
  }
  if (t === 'microsoft.cache/redis' || t === 'microsoft.cache/redisenterprise') {
    return [
      { key: 'connect', label: L('Chiavi e connessione', 'Keys and connection'), render: () => <RedisConnect id={id} r={r} apiVersion={apiVersion} /> },
      { key: 'scale', label: L('Scalabilità', 'Scale'), render: () => <RedisScale id={id} r={r} apiVersion={apiVersion} reload={reload} /> },
      { key: 'settings', label: L('Impostazioni', 'Settings'), render: () => <RedisSettings id={id} r={r} apiVersion={apiVersion} reload={reload} /> },
      ...(t === 'microsoft.cache/redis' ? [{ key: 'firewall', label: L('Firewall', 'Firewall'), render: () => <RedisFirewall id={id} apiVersion={apiVersion} /> }] : []),
    ];
  }
  if (t === 'microsoft.compute/virtualmachines') {
    return [
      { key: 'size', label: L('Dimensioni', 'Size'), render: () => <VmSize id={id} vm={r} reload={reload} /> },
      { key: 'disks', label: L('Dischi', 'Disks'), render: () => <VmDisks id={id} vm={r} reload={reload} /> },
      { key: 'network', label: L('Rete', 'Networking'), render: () => <VmNetworking vm={r} /> },
    ];
  }
  if (t === 'microsoft.app/containerapps') {
    return [
      { key: 'containers', label: L('Contenitori', 'Containers'), render: () => <CaContainers id={id} app={r} reload={reload} /> },
      { key: 'ingress', label: L('Ingresso', 'Ingress'), render: () => <CaIngress id={id} app={r} reload={reload} /> },
      { key: 'scale', label: L('Scalabilità', 'Scale'), render: () => <CaScale id={id} app={r} reload={reload} /> },
      { key: 'secrets', label: L('Segreti', 'Secrets'), render: () => <CaSecrets id={id} app={r} reload={reload} /> },
      { key: 'revisions', label: L('Revisioni', 'Revisions'), render: () => <CaRevisions id={id} app={r} reload={reload} /> },
    ];
  }
  if (t === 'microsoft.containerregistry/registries') {
    return [
      { key: 'access', label: L('Chiavi di accesso', 'Access keys'), render: () => <AcrAccess id={id} r={r} reload={reload} /> },
      { key: 'webhooks', label: L('Webhook', 'Webhooks'), render: () => <AcrWebhooks id={id} r={r} /> },
      { key: 'sku', label: L('Piano', 'Tier'), render: () => <AcrSku id={id} r={r} reload={reload} /> },
    ];
  }
  if (t === 'microsoft.containerservice/managedclusters') {
    return [
      { key: 'pools', label: L('Pool di nodi', 'Node pools'), render: () => <AksPools id={id} cluster={r} reload={reload} /> },
      { key: 'upgrade', label: L('Versione', 'Version'), render: () => <AksUpgrade id={id} cluster={r} reload={reload} /> },
    ];
  }
  const mk = msgKind(type);
  if (mk) {
    return [
      { key: 'entities', label: mk === 'servicebus' ? L('Code e argomenti', 'Queues and topics') : L('Hub eventi', 'Event hubs'), render: () => (mk === 'servicebus' ? <SbEntities id={id} ns={r} /> : <EhEntities id={id} ns={r} />) },
      { key: 'policies', label: L('Criteri di accesso condiviso', 'Shared access policies'), render: () => <MsgPolicies id={id} ns={r} kind={mk} /> },
    ];
  }
  if (t === 'microsoft.appconfiguration/configurationstores') {
    return [
      { key: 'values', label: L('Esplora configurazione', 'Configuration explorer'), render: () => <AppConfigValues id={id} store={r} /> },
      { key: 'accesskeys', label: L('Chiavi di accesso', 'Access keys'), render: () => <AppConfigKeys id={id} store={r} /> },
    ];
  }
  if (t === 'microsoft.operationalinsights/workspaces') return [{ key: 'settings', label: L('Utilizzo e conservazione', 'Usage and retention'), render: () => <LawSettings id={id} ws={r} reload={reload} /> }];
  if (t === 'microsoft.insights/components') return [{ key: 'settings', label: L('Connessione e impostazioni', 'Connection and settings'), render: () => <AppInsightsSettings id={id} ai={r} reload={reload} /> }];
  if (t === 'microsoft.documentdb/databaseaccounts') return [{ key: 'explorer', label: L('Esplora dati', 'Data explorer'), render: () => <CosmosExplorer accountId={id} account={r} /> }];
  if (t === 'microsoft.storage/storageaccounts') {
    return [
      { key: 'data', label: L('Contenitori, code, tabelle', 'Containers, queues, tables'), render: () => <StorageData accountId={id} /> },
      { key: 'config', label: L('Configurazione', 'Configuration'), render: () => <StorageConfig id={id} acc={r} reload={reload} /> },
      { key: 'network', label: L('Rete', 'Networking'), render: () => <StorageNetworking id={id} acc={r} reload={reload} /> },
      { key: 'lifecycle', label: L('Ciclo di vita', 'Lifecycle management'), render: () => <StorageLifecycle id={id} /> },
      { key: 'sas', label: L('Firma di accesso condiviso', 'Shared access signature'), render: () => <StorageSas id={id} acc={r} /> },
    ];
  }
  if (t === 'microsoft.cognitiveservices/accounts') {
    const deploy = supportsDeployments(r);
    return [
      ...(deploy ? [{ key: 'deployments', label: L('Distribuzioni di modelli', 'Model deployments'), render: () => <AiDeployments id={id} /> }] : []),
      ...(String(r.kind).toLowerCase() === 'aiservices' ? [{ key: 'projects', label: L('Progetti', 'Projects'), render: () => <AiProjects id={id} account={r} /> }] : []),
      { key: 'endpoint', label: L('Chiavi ed endpoint', 'Keys and endpoint'), render: () => <AiKeys id={id} account={r} /> },
      { key: 'network', label: L('Rete e autenticazione', 'Networking and authentication'), render: () => <AiNetworking id={id} account={r} reload={reload} /> },
    ];
  }
  if (t === 'microsoft.keyvault/vaults') {
    return [
      { key: 'vaultkeys', label: L('Chiavi', 'Keys'), render: () => <VaultKeys id={id} /> },
      { key: 'access', label: L('Configurazione di accesso', 'Access configuration'), render: () => <VaultAccess id={id} vault={r} reload={reload} /> },
      { key: 'network', label: L('Rete', 'Networking'), render: () => <VaultNetworking id={id} vault={r} reload={reload} /> },
    ];
  }
  if (t === 'microsoft.web/staticsites') {
    return [
      { key: 'domains', label: L('Domini personalizzati', 'Custom domains'), render: () => <SwaDomains id={id} site={r} /> },
      { key: 'appsettings', label: L('Impostazioni dell\'app', 'App settings'), render: () => <SwaSettings id={id} /> },
      { key: 'plan', label: L('Piano', 'Hosting plan'), render: () => <SwaPlan id={id} site={r} reload={reload} /> },
    ];
  }
  if (t === 'microsoft.search/searchservices') {
    return [
      { key: 'scale', label: L('Scala', 'Scale'), render: () => <SearchScale id={id} svc={r} reload={reload} /> },
      { key: 'searchkeys', label: L('Chiavi ed endpoint', 'Keys and endpoint'), render: () => <SearchKeys id={id} svc={r} /> },
    ];
  }
  if (t === 'microsoft.signalrservice/signalr' || t === 'microsoft.signalrservice/webpubsub') {
    return [
      { key: 'scale', label: L('Piano e unità', 'Tier and units'), render: () => <SignalRScale id={id} r={r} reload={reload} /> },
      { key: 'connkeys', label: L('Chiavi e connessione', 'Keys and connection'), render: () => <SignalRKeys id={id} r={r} /> },
    ];
  }
  if (t === 'microsoft.network/virtualnetworks') {
    return [
      { key: 'subnets', label: L('Subnet', 'Subnets'), render: () => <VnetSubnets id={id} vnet={r} reload={reload} /> },
      { key: 'address', label: L('Spazio di indirizzi e DNS', 'Address space and DNS'), render: () => <VnetAddressSpace id={id} vnet={r} reload={reload} /> },
      { key: 'peerings', label: L('Peering', 'Peerings'), render: () => <VnetPeerings id={id} vnet={r} reload={reload} /> },
    ];
  }
  if (t === 'microsoft.network/networksecuritygroups') {
    return [
      { key: 'rules', label: L('Regole di sicurezza', 'Security rules'), render: () => <NsgRulesEditor id={id} nsg={r} reload={reload} /> },
      { key: 'assoc', label: L('Associazioni', 'Associations'), render: () => <SubnetAssociations id={id} r={r} kind="networkSecurityGroup" reload={reload} /> },
    ];
  }
  if (t === 'microsoft.network/routetables') {
    return [
      { key: 'routes', label: L('Route', 'Routes'), render: () => <RouteTableRoutes id={id} rt={r} reload={reload} /> },
      { key: 'assoc', label: L('Associazioni', 'Associations'), render: () => <SubnetAssociations id={id} r={r} kind="routeTable" reload={reload} /> },
    ];
  }
  if (t === 'microsoft.network/natgateways') {
    return [{ key: 'assoc', label: L('IP in uscita e subnet', 'Outbound IPs and subnets'), render: () => <><NatGatewaySettings nat={r} /><div className="mt-16"><SubnetAssociations id={id} r={r} kind="natGateway" reload={reload} /></div></> }];
  }
  if (t === 'microsoft.network/publicipaddresses') return [{ key: 'config', label: L('Configurazione', 'Configuration'), render: () => <PublicIpSettings id={id} pip={r} reload={reload} /> }];
  if (t === 'microsoft.network/loadbalancers') return [{ key: 'config', label: L('Front-end, pool e regole', 'Frontends, pools and rules'), render: () => <LoadBalancerConfig id={id} lb={r} reload={reload} /> }];
  if (t === 'microsoft.network/dnszones') return [{ key: 'records', label: L('Record set', 'Record sets'), render: () => <DnsRecordSets zoneId={id} zone={r} isPrivate={false} /> }];
  if (t === 'microsoft.network/privatednszones') {
    return [
      { key: 'records', label: L('Record set', 'Record sets'), render: () => <DnsRecordSets zoneId={id} zone={r} isPrivate /> },
      { key: 'links', label: L('Collegamenti alle reti', 'Network links'), render: () => <PrivateDnsLinks zoneId={id} /> },
    ];
  }
  return [];
}

import { useAsync } from '@/lib/hooks';
import { arm } from '@/lib/api';
import { Skeleton } from '../ui';
function ServerConnect({ serverId, kind, database }: { serverId: string; kind: DbKind; database: string }) {
  const server = useAsync(() => arm.get<any>(serverId, '2023-08-01-preview'), [serverId]);
  return server.data ? <DbConnect server={server.data} kind={kind} database={database} /> : <Skeleton rows={4} />;
}
