import * as store from '../db/store.ts';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { expandToUsers, groupsOf } from '../directory.ts';
import type { Principal } from '../types.ts';
import { isAncestorOrSelf } from './path.ts';

export interface Permission { actions: string[]; notActions: string[]; dataActions: string[]; notDataActions: string[] }
export interface RoleDef {
  name: string;
  roleName: string;
  description: string;
  type: 'BuiltInRole' | 'CustomRole';
  permissions: Permission[];
  assignableScopes: string[];
  createdOn?: string;
  updatedOn?: string;
  createdBy?: string | null;
  updatedBy?: string | null;
}

const P = (actions: string[], notActions: string[] = [], dataActions: string[] = [], notDataActions: string[] = []): Permission[] => [{ actions, notActions, dataActions, notDataActions }];
const B = (name: string, roleName: string, description: string, permissions: Permission[]): RoleDef => ({
  name, roleName, description, type: 'BuiltInRole', permissions, assignableScopes: ['/'], createdOn: '2015-02-02T21:55:09.8806423Z', updatedOn: '2024-01-01T00:00:00.0000000Z', createdBy: null, updatedBy: null,
});

export const BUILTIN_ROLES: RoleDef[] = [
  B('8e3af657-a8ff-443c-a75c-2fe8c4bcb635', 'Owner', 'Grants full access to manage all resources, including the ability to assign roles in Azure RBAC.', P(['*'])),
  B('b24988ac-6180-42a0-ab88-20f7382dd24c', 'Contributor', 'Grants full access to manage all resources, but does not allow you to assign roles in Azure RBAC, manage assignments in Azure Blueprints, or share image galleries.', P(['*'], ['Microsoft.Authorization/*/Delete', 'Microsoft.Authorization/*/Write', 'Microsoft.Authorization/elevateAccess/Action', 'Microsoft.Blueprint/blueprintAssignments/write', 'Microsoft.Blueprint/blueprintAssignments/delete', 'Microsoft.Compute/galleries/share/action', 'Microsoft.Purview/consents/write', 'Microsoft.Purview/consents/delete'])),
  B('acdd72a7-3385-48ef-bd42-f606fba81ae7', 'Reader', 'View all resources, but does not allow you to make any changes.', P(['*/read'])),
  B('18d7d88d-d35e-4fb5-a5c3-7773c20a72d9', 'User Access Administrator', 'Lets you manage user access to Azure resources.', P(['*/read', 'Microsoft.Authorization/*', 'Microsoft.Support/*'])),
  B('f58310d9-a9f6-439a-9e8d-f62e7b41a168', 'Role Based Access Control Administrator', 'Manage access to Azure resources by assigning roles using Azure RBAC. This role does not allow you to manage access using other ways, such as Azure Policy.', P(['Microsoft.Authorization/roleAssignments/write', 'Microsoft.Authorization/roleAssignments/delete', '*/read', 'Microsoft.Support/*'])),
  B('17d1049b-9a84-46fb-8f53-869881c3d3ab', 'Storage Account Contributor', 'Lets you manage storage accounts, including accessing storage account keys which provide full access to storage account data.', P(['Microsoft.Authorization/*/read', 'Microsoft.Insights/alertRules/*', 'Microsoft.Insights/diagnosticSettings/*', 'Microsoft.Network/virtualNetworks/subnets/joinViaServiceEndpoint/action', 'Microsoft.ResourceHealth/availabilityStatuses/read', 'Microsoft.Resources/deployments/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Storage/storageAccounts/*', 'Microsoft.Support/*'])),
  B('ba92f5b4-2d11-453d-a403-e96b0029c9fe', 'Storage Blob Data Contributor', 'Read, write, and delete Azure Storage containers and blobs.', P(['Microsoft.Storage/storageAccounts/blobServices/containers/delete', 'Microsoft.Storage/storageAccounts/blobServices/containers/read', 'Microsoft.Storage/storageAccounts/blobServices/containers/write', 'Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action'], [], ['Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete', 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read', 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write', 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/move/action', 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action'])),
  B('2a2b9908-6ea1-4ae2-8e65-a410df84e7d1', 'Storage Blob Data Reader', 'Read and list Azure Storage containers and blobs.', P(['Microsoft.Storage/storageAccounts/blobServices/containers/read', 'Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action'], [], ['Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'])),
  B('b7e6dc6d-f1e8-4753-8033-0f276bb0955b', 'Storage Blob Data Owner', 'Provides full access to Azure Storage blob containers and data, including assigning POSIX access control.', P(['Microsoft.Storage/storageAccounts/blobServices/containers/*', 'Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action'], [], ['Microsoft.Storage/storageAccounts/blobServices/containers/blobs/*'])),
  B('974c5e8b-45b9-4653-ba55-5f855dd0fb88', 'Storage Queue Data Contributor', 'Read, write, and delete Azure Storage queues and queue messages.', P(['Microsoft.Storage/storageAccounts/queueServices/queues/*'], [], ['Microsoft.Storage/storageAccounts/queueServices/queues/messages/*'])),
  B('0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3', 'Storage Table Data Contributor', 'Allows for read, write and delete access to Azure Storage tables and entities.', P(['Microsoft.Storage/storageAccounts/tableServices/tables/*'], [], ['Microsoft.Storage/storageAccounts/tableServices/tables/entities/*'])),
  B('00482a5a-887f-4fb3-b363-3b7fe8e74483', 'Key Vault Administrator', 'Perform all data plane operations on a key vault and all objects in it, including certificates, keys, and secrets.', P(['Microsoft.Authorization/*/read', 'Microsoft.Insights/alertRules/*', 'Microsoft.Resources/deployments/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Support/*', 'Microsoft.KeyVault/checkNameAvailability/read', 'Microsoft.KeyVault/deletedVaults/read', 'Microsoft.KeyVault/locations/*/read', 'Microsoft.KeyVault/vaults/*/read', 'Microsoft.KeyVault/operations/read'], [], ['Microsoft.KeyVault/vaults/*'])),
  B('21090545-7ca7-4776-b22c-e363652d74d2', 'Key Vault Reader', 'Read metadata of key vaults and its certificates, keys, and secrets.', P(['Microsoft.Authorization/*/read', 'Microsoft.KeyVault/vaults/*/read', 'Microsoft.Resources/subscriptions/resourceGroups/read'], [], ['Microsoft.KeyVault/vaults/*/read'])),
  B('4633458b-17de-408a-b874-0445c86b69e6', 'Key Vault Secrets User', 'Read secret contents.', P([], [], ['Microsoft.KeyVault/vaults/secrets/getSecret/action', 'Microsoft.KeyVault/vaults/secrets/readMetadata/action'])),
  B('b86a8fe4-44ce-4948-aee5-eccb2c155cd7', 'Key Vault Secrets Officer', 'Perform any action on the secrets of a key vault, except manage permissions.', P(['Microsoft.Authorization/*/read', 'Microsoft.KeyVault/vaults/*/read', 'Microsoft.Resources/subscriptions/resourceGroups/read'], [], ['Microsoft.KeyVault/vaults/secrets/*'])),
  B('f25e0fa2-a7c8-4377-a976-54943a77a395', 'Key Vault Contributor', 'Lets you manage key vaults, but not access to them.', P(['Microsoft.Authorization/*/read', 'Microsoft.Insights/alertRules/*', 'Microsoft.KeyVault/*', 'Microsoft.Resources/deployments/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Support/*'], ['Microsoft.KeyVault/locations/deletedVaults/purge/action', 'Microsoft.KeyVault/hsmPools/*', 'Microsoft.KeyVault/managedHsms/*'])),
  B('4d97b98b-1d4f-4787-a291-c67834d212e7', 'Network Contributor', 'Lets you manage networks, but not access to them.', P(['Microsoft.Authorization/*/read', 'Microsoft.Insights/alertRules/*', 'Microsoft.Network/*', 'Microsoft.ResourceHealth/availabilityStatuses/read', 'Microsoft.Resources/deployments/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Support/*'])),
  B('9980e02c-c2be-4d73-94e8-173b1dc7cf3c', 'Virtual Machine Contributor', 'Create and manage virtual machines, manage disks, install and run software, reset password of the root user of the virtual machine using VM extensions, and manage local user accounts using VM extensions.', P(['Microsoft.Authorization/*/read', 'Microsoft.Compute/*', 'Microsoft.Insights/alertRules/*', 'Microsoft.Network/*/read', 'Microsoft.Network/networkInterfaces/*', 'Microsoft.Network/virtualNetworks/subnets/join/action', 'Microsoft.Network/publicIPAddresses/join/action', 'Microsoft.Resources/deployments/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Storage/storageAccounts/listKeys/action', 'Microsoft.Storage/storageAccounts/read', 'Microsoft.Support/*'])),
  B('de139f84-1756-47ae-9be6-808fbbe84772', 'Website Contributor', 'Lets you manage websites (not web plans), but not access to them.', P(['Microsoft.Authorization/*/read', 'Microsoft.Insights/alertRules/*', 'Microsoft.Insights/components/*', 'Microsoft.ResourceHealth/availabilityStatuses/read', 'Microsoft.Resources/deployments/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Support/*', 'Microsoft.Web/certificates/*', 'Microsoft.Web/listSitesAssignedToHostName/read', 'Microsoft.Web/serverFarms/join/action', 'Microsoft.Web/serverFarms/read', 'Microsoft.Web/sites/*'])),
  B('9b7fa17d-e63e-47b0-bb0a-15c516ac86ec', 'SQL DB Contributor', 'Lets you manage SQL databases, but not access to them.', P(['Microsoft.Authorization/*/read', 'Microsoft.Insights/alertRules/*', 'Microsoft.ResourceHealth/availabilityStatuses/read', 'Microsoft.Resources/deployments/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Sql/servers/databases/*', 'Microsoft.Sql/servers/read', 'Microsoft.Support/*'])),
  B('6d8ee4ec-f05a-4a1d-8b00-a9b17e38b437', 'SQL Server Contributor', 'Lets you manage SQL servers and databases, but not access to them, and not their security-related policies.', P(['Microsoft.Authorization/*/read', 'Microsoft.Insights/alertRules/*', 'Microsoft.Resources/deployments/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Sql/servers/*', 'Microsoft.Support/*'])),
  B('7f951dda-4ed3-4680-a7ca-43fe172d538d', 'AcrPull', 'acr pull', P(['Microsoft.ContainerRegistry/registries/pull/read'])),
  B('8311e382-0749-4cb8-b61a-304f252e45ec', 'AcrPush', 'acr push', P(['Microsoft.ContainerRegistry/registries/pull/read', 'Microsoft.ContainerRegistry/registries/push/write'])),
  B('4abbcc35-e782-43d8-92c5-2d3f1bd2253f', 'Azure Kubernetes Service Cluster User Role', 'List cluster user credential action.', P(['Microsoft.ContainerService/managedClusters/listClusterUserCredential/action', 'Microsoft.ContainerService/managedClusters/read'])),
  B('0ab0b1a8-8aac-4efd-b8c2-3ee1fb270be8', 'Azure Kubernetes Service Cluster Admin Role', 'List cluster admin credential action.', P(['Microsoft.ContainerService/managedClusters/listClusterAdminCredential/action', 'Microsoft.ContainerService/managedClusters/accessProfiles/listCredential/action', 'Microsoft.ContainerService/managedClusters/read', 'Microsoft.ContainerService/managedClusters/runcommand/action'])),
  B('ed7f3fbd-7b88-4dd4-9017-9adb7ce333f8', 'Azure Kubernetes Service Contributor Role', 'Grants access to read and write Azure Kubernetes Service clusters', P(['Microsoft.ContainerService/managedClusters/read', 'Microsoft.ContainerService/managedClusters/write', 'Microsoft.Resources/deployments/*'])),
  B('f1a07417-d97a-45cb-824c-7a7467783830', 'Managed Identity Operator', 'Read and Assign User Assigned Identity', P(['Microsoft.ManagedIdentity/userAssignedIdentities/*/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/*/assign/action', 'Microsoft.Authorization/*/read', 'Microsoft.Insights/alertRules/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Resources/deployments/*', 'Microsoft.Support/*'])),
  B('e40ec5ca-96e0-45a2-b4ff-59039f2c2b59', 'Managed Identity Contributor', 'Create, Read, Update, and Delete User Assigned Identity', P(['Microsoft.ManagedIdentity/userAssignedIdentities/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/write', 'Microsoft.ManagedIdentity/userAssignedIdentities/delete', 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/*', 'Microsoft.Authorization/*/read', 'Microsoft.Insights/alertRules/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Resources/deployments/*', 'Microsoft.Support/*'])),
  B('43d0d8ad-25c7-4714-9337-8ba259a9fe05', 'Monitoring Reader', 'Can read all monitoring data.', P(['*/read', 'Microsoft.OperationalInsights/workspaces/search/action', 'Microsoft.Support/*'])),
  B('749f88d5-cbae-40b8-bcfc-e573ddc772fa', 'Monitoring Contributor', 'Can read all monitoring data and update monitoring settings.', P(['*/read', 'Microsoft.AlertsManagement/*', 'Microsoft.Insights/*', 'Microsoft.OperationalInsights/workspaces/*', 'Microsoft.Support/*'])),
  B('92aaf0da-9dab-42b6-94a3-d43ce8d16293', 'Log Analytics Contributor', 'Log Analytics Contributor can read all monitoring data and edit monitoring settings.', P(['*/read', 'Microsoft.ClassicCompute/virtualMachines/extensions/*', 'Microsoft.Compute/virtualMachines/extensions/*', 'Microsoft.Insights/diagnosticSettings/*', 'Microsoft.OperationalInsights/*', 'Microsoft.OperationsManagement/*', 'Microsoft.Resources/deployments/*', 'Microsoft.Resources/subscriptions/resourcegroups/deployments/*', 'Microsoft.Storage/storageAccounts/listKeys/action', 'Microsoft.Support/*'])),
  B('090c5cfd-751d-490a-894a-3ce6f1109419', 'Azure Service Bus Data Owner', 'Allows for full access to Azure Service Bus resources.', P(['Microsoft.ServiceBus/*'], [], ['Microsoft.ServiceBus/*'])),
  B('69a216fc-b8fb-44d8-bc22-1f3c2cd27a39', 'Azure Service Bus Data Sender', 'Allows for send access to Azure Service Bus resources.', P(['Microsoft.ServiceBus/*/queues/read', 'Microsoft.ServiceBus/*/topics/read', 'Microsoft.ServiceBus/*/topics/subscriptions/read'], [], ['Microsoft.ServiceBus/*/send/action'])),
  B('4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0', 'Azure Service Bus Data Receiver', 'Allows for receive access to Azure Service Bus resources.', P(['Microsoft.ServiceBus/*/queues/read', 'Microsoft.ServiceBus/*/topics/read', 'Microsoft.ServiceBus/*/topics/subscriptions/read'], [], ['Microsoft.ServiceBus/*/receive/action'])),
  B('f526a384-b230-433a-b45c-95f59c4a2dec', 'Azure Event Hubs Data Owner', 'Allows for full access to Azure Event Hubs resources.', P(['Microsoft.EventHub/*'], [], ['Microsoft.EventHub/*'])),
  B('5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b', 'App Configuration Data Owner', 'Allows full access to App Configuration data.', P([], [], ['Microsoft.AppConfiguration/configurationStores/*/read', 'Microsoft.AppConfiguration/configurationStores/*/write', 'Microsoft.AppConfiguration/configurationStores/*/delete', 'Microsoft.AppConfiguration/configurationStores/*/action'])),
  B('a97b65f3-24c7-4388-baec-2e87135dc908', 'Cognitive Services User', 'Lets you read and list keys of Cognitive Services.', P(['Microsoft.CognitiveServices/*/read', 'Microsoft.CognitiveServices/accounts/listkeys/action', 'Microsoft.Insights/alertRules/read', 'Microsoft.Insights/diagnosticSettings/read', 'Microsoft.Insights/logDefinitions/read', 'Microsoft.Insights/metricdefinitions/read', 'Microsoft.Insights/metrics/read', 'Microsoft.ResourceHealth/availabilityStatuses/read', 'Microsoft.Resources/deployments/operations/read', 'Microsoft.Resources/subscriptions/operationresults/read', 'Microsoft.Resources/subscriptions/read', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Support/*'], [], ['Microsoft.CognitiveServices/*'])),
  B('5e0bd9bd-7b93-4f28-af87-19fc36ad61bd', 'Cognitive Services OpenAI User', 'Read access to view files, models, deployments. The ability to create completion and embedding calls.', P(['Microsoft.CognitiveServices/*/read', 'Microsoft.Authorization/roleAssignments/read', 'Microsoft.Authorization/roleDefinitions/read'], [], ['Microsoft.CognitiveServices/accounts/OpenAI/*/read', 'Microsoft.CognitiveServices/accounts/OpenAI/engines/completions/action', 'Microsoft.CognitiveServices/accounts/OpenAI/deployments/chat/completions/action'])),
  B('fbdf93bf-df7d-467e-a4d2-9458aa1360c8', 'Cosmos DB Account Reader Role', 'Can read Azure Cosmos DB Accounts data', P(['Microsoft.Authorization/*/read', 'Microsoft.DocumentDB/*/read', 'Microsoft.DocumentDB/databaseAccounts/readonlykeys/action', 'Microsoft.Insights/MetricDefinitions/read', 'Microsoft.Insights/Metrics/read', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Support/*'])),
  B('5bd9cd88-fe45-4216-938b-f97437e15450', 'DocumentDB Account Contributor', 'Can manage Azure Cosmos DB accounts.', P(['Microsoft.Authorization/*/read', 'Microsoft.DocumentDb/databaseAccounts/*', 'Microsoft.Insights/alertRules/*', 'Microsoft.Resources/deployments/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Support/*'])),
];

const builtinByName = new Map(BUILTIN_ROLES.map((r) => [r.name.toLowerCase(), r]));

export async function getRoleDefinition(guid: string): Promise<RoleDef | null> {
  const g = guid.toLowerCase();
  return builtinByName.get(g) ?? (await store.get<RoleDef>('roleDefinition', g));
}

export async function allRoleDefinitions(): Promise<RoleDef[]> {
  return [...BUILTIN_ROLES, ...(await store.list<RoleDef>('roleDefinition'))];
}

export function roleGuidFromId(roleDefinitionId: string): string {
  return roleDefinitionId.split('/').pop()!.toLowerCase();
}

export function roleDefinitionResource(def: RoleDef, scope: string) {
  return {
    id: `${scope === '/' ? '' : scope}/providers/Microsoft.Authorization/roleDefinitions/${def.name}`,
    type: 'Microsoft.Authorization/roleDefinitions',
    name: def.name,
    properties: {
      roleName: def.roleName,
      type: def.type,
      description: def.description,
      assignableScopes: def.assignableScopes,
      permissions: def.permissions,
      createdOn: def.createdOn ?? null,
      updatedOn: def.updatedOn ?? null,
      createdBy: def.createdBy ?? null,
      updatedBy: def.updatedBy ?? null,
    },
  };
}

function actionMatch(pattern: string, action: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(action);
}

export function roleAllows(def: RoleDef, action: string): boolean {
  return def.permissions.some((p) => p.actions.some((a) => actionMatch(a, action)) && !p.notActions.some((a) => actionMatch(a, action)));
}

export interface Access {
  bypass: boolean;
  principalIds: string[];
  grants: { scope: string; role: RoleDef }[];
}

export async function loadAccess(p: Principal): Promise<Access> {
  if (!config.rbac || p.via === 'lax') return { bypass: true, principalIds: [p.oid], grants: [] };
  const ids = [p.oid, ...(await groupsOf(p.oid))];
  const assignments = await store.list('roleAssignment', { match: {} });
  const mine = assignments.filter((a) => ids.includes(a.properties.principalId));
  const grants: Access['grants'] = [];
  for (const a of mine) {
    const role = await getRoleDefinition(roleGuidFromId(a.properties.roleDefinitionId));
    if (role) grants.push({ scope: a._scope, role });
  }
  return { bypass: false, principalIds: ids, grants };
}

export function can(access: Access, action: string, scope: string): boolean {
  if (access.bypass) return true;
  return access.grants.some((g) => isAncestorOrSelf(g.scope, scope) && roleAllows(g.role, action));
}

/** Il principal ha qualche permesso sotto o sopra questo scope? (per elencare le sottoscrizioni) */
export function hasAnyAccessWithin(access: Access, scope: string): boolean {
  if (access.bypass) return true;
  const s = scope.toLowerCase();
  return access.grants.some((g) => isAncestorOrSelf(g.scope, s) || g.scope.startsWith(s + '/'));
}

export function permissionsAt(access: Access, scope: string): Permission[] {
  if (access.bypass) return P(['*']);
  return access.grants.filter((g) => isAncestorOrSelf(g.scope, scope)).flatMap((g) => g.role.permissions);
}

export function authorizationFailed(p: Principal, action: string, scope: string): HttpError {
  const who = p.kind === 'app' ? `'${p.appId}' with object id '${p.oid}'` : `'${p.upn}' with object id '${p.oid}'`;
  return new HttpError(403, 'AuthorizationFailed', `The client ${who} does not have authorization to perform action '${action}' over scope '${scope}' or the scope is invalid. If access was recently granted, please refresh your credentials.`);
}

/** Utenti che hanno permessi di scrittura su uno scope (destinatari delle notifiche). */
export async function scopeWatchers(scope: string): Promise<string[]> {
  const assignments = await store.list('roleAssignment');
  const ids: string[] = [];
  for (const a of assignments) {
    if (!isAncestorOrSelf(a._scope, scope)) continue;
    const role = await getRoleDefinition(roleGuidFromId(a.properties.roleDefinitionId));
    if (role && roleAllows(role, 'Microsoft.Resources/subscriptions/resourceGroups/write')) ids.push(a.properties.principalId);
  }
  return expandToUsers(ids);
}
