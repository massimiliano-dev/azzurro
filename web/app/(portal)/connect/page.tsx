'use client';

import { useState } from 'react';
import { KeyRound, PlugZap } from 'lucide-react';
import { portal } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { PageHeader, Tabs } from '@/components/page';
import { Button, Card, CodeBlock, IdText, KV, Notice, SecretValue, Select, Skeleton } from '@/components/ui';
import { useSubscriptions } from '@/components/pickers';
import { useToast } from '@/components/overlay';

export default function ConnectPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { session } = useSession();
  const cfg = useAsync(() => portal.get<any>('/config'), []);
  const subs = useSubscriptions();
  const [sdk, setSdk] = useState('cli');
  const [aud, setAud] = useState('arm');
  const [token, setToken] = useState<string | null>(null);
  if (!cfg.data) return <Skeleton rows={8} />;
  const c = cfg.data;
  const base = c.httpsAvailable ? c.httpsUrl : c.apiUrl;
  const tid = c.tenantId;
  const sub = subs.data?.[0]?.subscriptionId ?? '<subscription-id>';
  const user = session?.user.userPrincipalName ?? `admin@${c.defaultDomain}`;
  const snippets: Record<string, string> = {
    cli: `# 1) rendi attendibile il certificato (vedi README) e registra il cloud
export REQUESTS_CA_BUNDLE=$PWD/certs/azzurro.pem
az config set core.instance_discovery=false
az cloud register -n Azzurro --endpoint-resource-manager ${base}/
az cloud set -n Azzurro

# 2) accedi (browser, device code o password)
az login --tenant ${tid}
az login --tenant ${tid} --use-device-code
az login --tenant ${tid} -u ${user} -p '<password>'

# 3) usa Azure come sempre
az account set -s ${sub}
az group create -n demo-rg -l italynorth
az storage account create -n demostorage$RANDOM -g demo-rg -l italynorth --sku Standard_LRS
az ad app create --display-name my-app
az deployment group create -g demo-rg -f main.bicep`,
    js: `// npm i @azure/identity @azure/arm-resources
// NODE_EXTRA_CA_CERTS=./certs/azzurro.pem
import { ClientSecretCredential } from '@azure/identity';
import { ResourceManagementClient } from '@azure/arm-resources';

const credential = new ClientSecretCredential('${tid}', '<client-id>', '<client-secret>', {
  authorityHost: '${base}',
  disableInstanceDiscovery: true,
});
const client = new ResourceManagementClient(credential, '${sub}', {
  endpoint: '${base}',
  credentialScopes: ['https://management.azure.com/.default'],
});
for await (const rg of client.resourceGroups.list()) console.log(rg.name);`,
    python: `# pip install azure-identity azure-mgmt-resource
# export REQUESTS_CA_BUNDLE=./certs/azzurro.pem
from azure.identity import ClientSecretCredential
from azure.mgmt.resource import ResourceManagementClient

credential = ClientSecretCredential(
    "${tid}", "<client-id>", "<client-secret>",
    authority="${base.replace(/^https?:\/\//, '')}", disable_instance_discovery=True,
)
client = ResourceManagementClient(credential, "${sub}", base_url="${base}",
                                  credential_scopes=["https://management.azure.com/.default"])
for rg in client.resource_groups.list():
    print(rg.name)`,
    dotnet: `// dotnet add package Azure.Identity Azure.ResourceManager
using Azure.Core;
using Azure.Identity;
using Azure.ResourceManager;

var credential = new ClientSecretCredential("${tid}", "<client-id>", "<client-secret>",
    new ClientSecretCredentialOptions { AuthorityHost = new Uri("${base}"), DisableInstanceDiscovery = true });
var arm = new ArmClient(credential, "${sub}", new ArmClientOptions {
    Environment = new ArmEnvironment(new Uri("${base}/"), "https://management.azure.com/"),
});
await foreach (var rg in arm.GetDefaultSubscription().GetResourceGroups()) Console.WriteLine(rg.Data.Name);`,
    terraform: `# export SSL_CERT_FILE=$PWD/certs/azzurro.pem
provider "azurerm" {
  features {}
  metadata_host   = "${base.replace(/^https?:\/\//, '')}"
  environment     = "Azzurro"
  tenant_id       = "${tid}"
  subscription_id = "${sub}"
  client_id       = "<client-id>"
  client_secret   = "<client-secret>"
}

provider "azuread" {
  metadata_host = "${base.replace(/^https?:\/\//, '')}"
  tenant_id     = "${tid}"
}`,
    env: `AZURE_TENANT_ID=${tid}
AZURE_SUBSCRIPTION_ID=${sub}
AZURE_AUTHORITY_HOST=${base}
AZURE_CLIENT_ID=<client-id>
AZURE_CLIENT_SECRET=<client-secret>
# Managed Identity (App Service style)
IDENTITY_ENDPOINT=${c.apiUrl}/msi/token
IDENTITY_HEADER=azzurro
# Managed Identity (IMDS)
AZURE_POD_IDENTITY_AUTHORITY_HOST=${c.apiUrl}`,
  };
  return (
    <>
      <PageHeader title={t('conn.title')} subtitle={t('conn.subtitle')} icon={PlugZap} />
      {c.httpsAvailable ? <Notice tone="ok">{t('conn.httpsOk', { url: c.httpsUrl })}</Notice> : <Notice tone="warn" title={t('conn.https')}>{t('conn.httpsMissing')}</Notice>}
      <div className="grid cols-2 mt-16" style={{ alignItems: 'start' }}>
        <Card title={t('conn.endpoints')}>
          <KV items={[
            [t('conn.tenant'), <IdText key="t" value={tid} />],
            [t('conn.arm'), <IdText key="a" value={`${base}/`} />],
            [t('conn.graph'), <IdText key="g" value={`${base}/v1.0`} />],
            [t('conn.login'), <IdText key="l" value={`${base}/${tid}`} />],
            [t('conn.metadata'), <IdText key="m" value={`${base}/metadata/endpoints?api-version=2022-09-01`} />],
            [t('conn.imds'), <IdText key="i" value={`${c.apiUrl}/metadata/identity/oauth2/token`} />],
          ]} />
        </Card>
        <Card title={t('conn.token')}>
          <p className="small muted mb-16">{t('conn.tokenHint')}</p>
          <div className="input-group">
            <Select value={aud} onChange={(e) => setAud(e.target.value)} aria-label={t('conn.tokenFor')}>
              <option value="arm">Azure Resource Manager</option>
              <option value="graph">Microsoft Graph</option>
            </Select>
            <Button icon={KeyRound} onClick={async () => { try { setToken((await portal.post<any>('/token', { resource: aud })).access_token); } catch (e) { toast.error(e); } }}>{t('conn.getToken')}</Button>
          </div>
          {token && <div className="mt-16"><SecretValue value={token} /></div>}
          {token && <div className="mt-8"><CodeBlock value={`curl -H "Authorization: Bearer $TOKEN" "${c.apiUrl}/subscriptions?api-version=2022-12-01"`} /></div>}
        </Card>
      </div>
      <section className="mt-24">
        <Tabs value={sdk} onChange={setSdk} tabs={[{ key: 'cli', label: t('conn.cli') }, { key: 'js', label: 'JavaScript' }, { key: 'python', label: 'Python' }, { key: 'dotnet', label: '.NET' }, { key: 'terraform', label: t('conn.terraform') }, { key: 'env', label: t('conn.env') }]} />
        {sdk === 'cli' && <p className="muted mb-16">{t('conn.cliHint')}</p>}
        <CodeBlock value={snippets[sdk]} maxHeight={900} />
      </section>
    </>
  );
}
