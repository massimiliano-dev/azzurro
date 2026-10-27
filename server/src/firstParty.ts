/**
 * App e service principal "first-party" di Microsoft presenti in ogni tenant,
 * con gli stessi appId/GUID di Azure, così Azure CLI, PowerShell e SDK
 * funzionano senza configurazione aggiuntiva.
 */

export const MICROSOFT_TENANT = 'f8cdef31-a31e-4b4a-93e4-5f571e91255a';

export const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
export const ARM_APP_ID = '797f4846-ba00-4fd7-ba43-dac1f8f63013';
export const AZURE_CLI_APP_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
export const AZURE_POWERSHELL_APP_ID = '1950a258-227b-4e31-a9cf-717495945fc2';
export const VSCODE_APP_ID = 'aebc6443-996d-45c2-90f0-388ff96faa56';
export const VISUAL_STUDIO_APP_ID = '04f0c124-f2bc-4f59-8241-bf6df9866bbd';
export const PORTAL_APP_ID = 'c44b4083-3bb0-49c1-b47d-974e53cbdf3c';

export const GRAPH_RESOURCE = 'https://graph.microsoft.com';
export const ARM_RESOURCES = ['https://management.core.windows.net/', 'https://management.azure.com/', 'https://management.core.windows.net', 'https://management.azure.com'];

interface Role { id: string; value: string; displayName: string; description: string }

const r = (id: string, value: string, displayName: string, description = displayName): Role => ({ id, value, displayName, description });

export const GRAPH_APP_ROLES: Role[] = [
  r('9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30', 'Application.Read.All', 'Read all applications'),
  r('1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9', 'Application.ReadWrite.All', 'Read and write all applications'),
  r('18a4783c-866b-4cc7-a460-3d5e5662c884', 'Application.ReadWrite.OwnedBy', 'Manage apps that this app creates or owns'),
  r('06b708a9-e830-4db3-a914-8e69da51d44f', 'AppRoleAssignment.ReadWrite.All', 'Manage app permission grants and app role assignments'),
  r('b0afded3-3588-46d8-8b3d-9842eff778da', 'AuditLog.Read.All', 'Read all audit log data'),
  r('7ab1d382-f21e-4acd-a863-ba3e13f7da61', 'Directory.Read.All', 'Read directory data'),
  r('19dbc75e-c2e2-444c-a770-ec69d8559fc7', 'Directory.ReadWrite.All', 'Read and write directory data'),
  r('5b567255-7703-4780-807c-7be8301ae99b', 'Group.Read.All', 'Read all groups'),
  r('62a82d76-70ea-41e2-9197-370581804d09', 'Group.ReadWrite.All', 'Read and write all groups'),
  r('98830695-27a2-44f7-8c18-0c3ebc9698f6', 'GroupMember.Read.All', 'Read all group memberships'),
  r('dbaae8cf-10b5-4b86-a4a1-f871c94c1695', 'GroupMember.ReadWrite.All', 'Read and write all group memberships'),
  r('483bed4a-2ad3-4361-a73b-c83ccdbdc53c', 'RoleManagement.Read.Directory', 'Read all directory RBAC settings'),
  r('9e3f62cf-ca93-4989-b6ce-bf83c28f9fe8', 'RoleManagement.ReadWrite.Directory', 'Read and write all directory RBAC settings'),
  r('df021288-bdef-4463-88db-98f22de89214', 'User.Read.All', 'Read all users\' full profiles'),
  r('741f803b-c850-494e-b5df-cde7c675a1ca', 'User.ReadWrite.All', 'Read and write all users\' full profiles'),
];

interface Scope { id: string; value: string; adminConsentDisplayName: string; adminConsentDescription: string; userConsentDisplayName: string; userConsentDescription: string; type: 'User' | 'Admin'; isEnabled: boolean }

const s = (id: string, value: string, name: string, type: 'User' | 'Admin' = 'User'): Scope => ({
  id, value, type, isEnabled: true,
  adminConsentDisplayName: name, adminConsentDescription: name,
  userConsentDisplayName: name, userConsentDescription: name,
});

export const GRAPH_SCOPES: Scope[] = [
  s('37f7f235-527c-4136-accd-4a02d197296e', 'openid', 'Sign users in'),
  s('14dad69e-099b-42c9-810b-d002981feec1', 'profile', 'View users\' basic profile'),
  s('64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0', 'email', 'View users\' email address'),
  s('7427e0e9-2fba-42fe-b0c0-848c9e6a8182', 'offline_access', 'Maintain access to data you have given it access to'),
  s('e1fe6dd8-ba31-4d61-89e7-88639da4683d', 'User.Read', 'Sign in and read user profile'),
  s('a154be20-db9c-4678-8ab7-66f6cc099a59', 'User.Read.All', 'Read all users\' full profiles', 'Admin'),
  s('204e0828-b5ca-4ad8-b9f3-f32a958e7cc4', 'User.ReadWrite.All', 'Read and write all users\' full profiles', 'Admin'),
  s('5f8c59db-677d-491f-a6b8-5f174b11ec1d', 'Group.Read.All', 'Read all groups', 'Admin'),
  s('4e46008b-f24c-477d-8fff-7bb4ec7aafe0', 'Group.ReadWrite.All', 'Read and write all groups', 'Admin'),
  s('c79f8feb-a9db-4090-85f9-90d820caa0eb', 'Application.Read.All', 'Read applications', 'Admin'),
  s('bdfbf15f-ee85-4955-8675-146e8e5296b5', 'Application.ReadWrite.All', 'Read and write all applications', 'Admin'),
  s('06da0dbc-49e2-44d2-8312-53f166ab848a', 'Directory.Read.All', 'Read directory data', 'Admin'),
  s('c5366453-9fb0-48a5-a156-24f0c49a4b84', 'Directory.ReadWrite.All', 'Read and write directory data', 'Admin'),
  s('0e263e50-5827-48a4-b97c-d940288653c7', 'Directory.AccessAsUser.All', 'Access directory as the signed in user', 'Admin'),
];

export const ARM_SCOPES: Scope[] = [
  s('41094075-9dad-400e-a0bd-54e686782033', 'user_impersonation', 'Access Azure Service Management as organization users'),
];

export interface FirstPartyApp {
  appId: string;
  displayName: string;
  publicClient: boolean;
  servicePrincipalNames: string[];
  appRoles?: Role[];
  scopes?: Scope[];
}

export const FIRST_PARTY: FirstPartyApp[] = [
  { appId: GRAPH_APP_ID, displayName: 'Microsoft Graph', publicClient: false, servicePrincipalNames: [GRAPH_APP_ID, 'https://graph.microsoft.com', 'https://graph.microsoft.com/', 'https://canary.graph.microsoft.com', 'https://graph.microsoft.us', 'https://dod-graph.microsoft.us', 'https://graph.microsoft.de', 'https://microsoftgraph.chinacloudapi.cn', 'https://ags.windows.net'], appRoles: GRAPH_APP_ROLES, scopes: GRAPH_SCOPES },
  { appId: ARM_APP_ID, displayName: 'Windows Azure Service Management API', publicClient: false, servicePrincipalNames: [ARM_APP_ID, ...ARM_RESOURCES], scopes: ARM_SCOPES },
  { appId: AZURE_CLI_APP_ID, displayName: 'Microsoft Azure CLI', publicClient: true, servicePrincipalNames: [AZURE_CLI_APP_ID] },
  { appId: AZURE_POWERSHELL_APP_ID, displayName: 'Microsoft Azure PowerShell', publicClient: true, servicePrincipalNames: [AZURE_POWERSHELL_APP_ID] },
  { appId: VSCODE_APP_ID, displayName: 'Visual Studio Code', publicClient: true, servicePrincipalNames: [VSCODE_APP_ID] },
  { appId: VISUAL_STUDIO_APP_ID, displayName: 'Visual Studio', publicClient: true, servicePrincipalNames: [VISUAL_STUDIO_APP_ID] },
  { appId: PORTAL_APP_ID, displayName: 'Azzurro Portal', publicClient: true, servicePrincipalNames: [PORTAL_APP_ID] },
];

export const firstPartyByAppId = new Map(FIRST_PARTY.map((a) => [a.appId, a]));

/** Ruoli di directory Entra ID (roleTemplateId reali). */
export const DIRECTORY_ROLES = [
  { id: '62e90394-69f5-4237-9190-012177145e10', displayName: 'Global Administrator', description: 'Can manage all aspects of Microsoft Entra ID and Microsoft services that use Microsoft Entra identities.' },
  { id: 'f2ef992c-3afb-46b9-b7cf-a126ee74c451', displayName: 'Global Reader', description: 'Can read everything that a Global Administrator can, but not update anything.' },
  { id: '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3', displayName: 'Application Administrator', description: 'Can create and manage all aspects of app registrations and enterprise apps.' },
  { id: '158c047a-c907-4556-b7ef-446551a6b5f7', displayName: 'Cloud Application Administrator', description: 'Can create and manage all aspects of app registrations and enterprise apps except App Proxy.' },
  { id: 'cf1c38e5-3621-4004-a7cb-879624dced7c', displayName: 'Application Developer', description: 'Can create application registrations independent of the \'Users can register applications\' setting.' },
  { id: 'fe930be7-5e62-47db-91af-98c3a49a38b1', displayName: 'User Administrator', description: 'Can manage all aspects of users and groups, including resetting passwords for limited admins.' },
  { id: 'fdd7a751-b60b-444a-984c-02652fe8fa1c', displayName: 'Groups Administrator', description: 'Members of this role can create/manage groups, create/manage groups settings like naming and expiration policies, and view groups activity and audit reports.' },
  { id: 'e8611ab8-c189-46e8-94e1-60213ab1f814', displayName: 'Privileged Role Administrator', description: 'Can manage role assignments in Microsoft Entra ID, and all aspects of Privileged Identity Management.' },
  { id: '729827e3-9c14-49f7-bb1b-9608f156bbb8', displayName: 'Helpdesk Administrator', description: 'Can reset passwords for non-administrators and Helpdesk Administrators.' },
  { id: '4a5d8f65-41da-4de4-8968-e035b65339cf', displayName: 'Reports Reader', description: 'Can read sign-in and audit reports.' },
  { id: '194ae4cb-b126-40b2-bd5b-6091b380977d', displayName: 'Security Administrator', description: 'Can read security information and reports, and manage configuration in Microsoft Entra ID and Office 365.' },
];

export const GLOBAL_ADMIN = DIRECTORY_ROLES[0].id;
export const GLOBAL_READER = DIRECTORY_ROLES[1].id;
export const APP_ADMIN = DIRECTORY_ROLES[2].id;
export const CLOUD_APP_ADMIN = DIRECTORY_ROLES[3].id;
export const APP_DEVELOPER = DIRECTORY_ROLES[4].id;
export const USER_ADMIN = DIRECTORY_ROLES[5].id;
export const GROUPS_ADMIN = DIRECTORY_ROLES[6].id;
export const PRIV_ROLE_ADMIN = DIRECTORY_ROLES[7].id;
export const HELPDESK_ADMIN = DIRECTORY_ROLES[8].id;
export const REPORTS_READER = DIRECTORY_ROLES[9].id;
