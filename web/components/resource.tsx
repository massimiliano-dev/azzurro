'use client';

import {
  Activity, AppWindow, Bell, Blocks, Bot, Box, Boxes, BrainCircuit, Cable, Cloud, Container, Cpu, Database, DatabaseZap, FileCode2, Fingerprint, Globe,
  HardDrive, KeyRound, Layers, LayoutGrid, Lock, Network, Radio, Router, Search, Server, ServerCog, Share2, Shield, ShieldCheck, Waypoints, Workflow, type LucideIcon,
} from 'lucide-react';
import { Badge } from './ui';
import { useT, type MessageKey } from '@/i18n';

const BY_TYPE: Record<string, LucideIcon> = {
  'microsoft.storage/storageaccounts': HardDrive,
  'microsoft.keyvault/vaults': KeyRound,
  'microsoft.web/serverfarms': ServerCog,
  'microsoft.web/sites': Globe,
  'microsoft.web/staticsites': Globe,
  'microsoft.sql/servers': Database,
  'microsoft.sql/servers/databases': Database,
  'microsoft.dbforpostgresql/flexibleservers': Database,
  'microsoft.dbformysql/flexibleservers': Database,
  'microsoft.documentdb/databaseaccounts': DatabaseZap,
  'microsoft.cache/redis': DatabaseZap,
  'microsoft.network/virtualnetworks': Network,
  'microsoft.network/networksecuritygroups': Shield,
  'microsoft.network/publicipaddresses': Waypoints,
  'microsoft.network/networkinterfaces': Cable,
  'microsoft.network/loadbalancers': Share2,
  'microsoft.network/applicationgateways': Router,
  'microsoft.network/privateendpoints': Cable,
  'microsoft.network/privatednszones': Globe,
  'microsoft.network/dnszones': Globe,
  'microsoft.compute/virtualmachines': Cpu,
  'microsoft.compute/disks': HardDrive,
  'microsoft.compute/virtualmachinescalesets': Layers,
  'microsoft.compute/sshpublickeys': KeyRound,
  'microsoft.containerregistry/registries': Boxes,
  'microsoft.containerservice/managedclusters': Container,
  'microsoft.app/managedenvironments': LayoutGrid,
  'microsoft.app/containerapps': Box,
  'microsoft.containerinstance/containergroups': Box,
  'microsoft.managedidentity/userassignedidentities': Fingerprint,
  'microsoft.operationalinsights/workspaces': Activity,
  'microsoft.insights/components': Activity,
  'microsoft.insights/actiongroups': Bell,
  'microsoft.servicebus/namespaces': Workflow,
  'microsoft.eventhub/namespaces': Radio,
  'microsoft.eventgrid/topics': Radio,
  'microsoft.logic/workflows': Workflow,
  'microsoft.signalrservice/signalr': Radio,
  'microsoft.apimanagement/service': Blocks,
  'microsoft.appconfiguration/configurationstores': ServerCog,
  'microsoft.cognitiveservices/accounts': Bot,
  'microsoft.search/searchservices': Search,
  'microsoft.machinelearningservices/workspaces': BrainCircuit,
  'microsoft.resources/resourcegroups': Layers,
  'microsoft.resources/deployments': FileCode2,
  'microsoft.resources/templatespecs': FileCode2,
  'microsoft.authorization/locks': Lock,
  'microsoft.recoveryservices/vaults': ShieldCheck,
  'microsoft.cdn/profiles': Cloud,
};

const CATEGORY_ICON: Record<string, LucideIcon> = {
  compute: Cpu, containers: Container, web: Globe, storage: HardDrive, databases: Database, networking: Network, identity: Fingerprint,
  security: Shield, integration: Workflow, monitor: Activity, ai: Bot, management: Server,
};

export function iconFor(type?: string, category?: string): LucideIcon {
  return BY_TYPE[type?.toLowerCase() ?? ''] ?? (category ? CATEGORY_ICON[category] : undefined) ?? AppWindow;
}

export function categoryOf(type: string): string {
  const ns = type.split('/')[0].toLowerCase();
  const map: Record<string, string> = {
    'microsoft.compute': 'compute', 'microsoft.containerregistry': 'containers', 'microsoft.containerservice': 'containers', 'microsoft.app': 'containers', 'microsoft.containerinstance': 'containers',
    'microsoft.web': 'web', 'microsoft.storage': 'storage', 'microsoft.sql': 'databases', 'microsoft.dbforpostgresql': 'databases', 'microsoft.dbformysql': 'databases',
    'microsoft.documentdb': 'databases', 'microsoft.cache': 'databases', 'microsoft.network': 'networking', 'microsoft.cdn': 'networking', 'microsoft.managedidentity': 'identity',
    'microsoft.keyvault': 'security', 'microsoft.servicebus': 'integration', 'microsoft.eventhub': 'integration', 'microsoft.eventgrid': 'integration', 'microsoft.logic': 'integration',
    'microsoft.signalrservice': 'integration', 'microsoft.apimanagement': 'integration', 'microsoft.appconfiguration': 'integration', 'microsoft.operationalinsights': 'monitor',
    'microsoft.insights': 'monitor', 'microsoft.portal': 'monitor', 'microsoft.cognitiveservices': 'ai', 'microsoft.search': 'ai', 'microsoft.machinelearningservices': 'ai',
  };
  return map[ns] ?? 'management';
}

export function ResourceIcon({ type, size = 'md' }: { type: string; size?: 'sm' | 'md' }) {
  const Icon = iconFor(type, categoryOf(type));
  return <span className={`res-icon c-${categoryOf(type)} ${size === 'sm' ? 'sm' : ''}`} aria-hidden><Icon size={size === 'sm' ? 13 : 16} /></span>;
}

export function StateBadge({ state }: { state?: string | null }) {
  const t = useT();
  const s = state ?? 'Unknown';
  const label = (['Succeeded', 'Failed', 'Running', 'Accepted', 'Canceled'].includes(s) ? t(`dep.state.${s}` as MessageKey) : s);
  if (s === 'Succeeded') return <Badge tone="ok">{label}</Badge>;
  if (s === 'Failed') return <Badge tone="bad">{label}</Badge>;
  if (s === 'Running' || s === 'Accepted') return <Badge tone="info" pulse>{label}</Badge>;
  if (s === 'Canceled') return <Badge tone="warn">{label}</Badge>;
  return <Badge>{label}</Badge>;
}
