export type Locale = 'it' | 'en';

export function pickLocale(...candidates: (string | null | undefined)[]): Locale {
  for (const c of candidates) {
    if (!c) continue;
    for (const part of c.split(',')) {
      const tag = part.trim().slice(0, 2).toLowerCase();
      if (tag === 'it' || tag === 'en') return tag;
    }
  }
  return 'it';
}

type Dict = Record<string, string>;

const it: Dict = {
  // notifiche
  'n.operationSucceeded.title': 'Operazione completata',
  'n.operationSucceeded.body': '{title}: completata.',
  'n.operationFailed.title': 'Operazione non riuscita',
  'n.operationFailed.body': '{title}: {error}',
  'n.operationCanceled.title': 'Operazione annullata',
  'n.operationCanceled.body': '{title}: annullata.',
  'n.deploymentSucceeded.title': 'Distribuzione completata',
  'n.deploymentSucceeded.body': 'La distribuzione «{name}» in {scope} è terminata correttamente.',
  'n.deploymentFailed.title': 'Distribuzione non riuscita',
  'n.deploymentFailed.body': 'La distribuzione «{name}» in {scope} non è riuscita: {error}',
  'n.rgCreated.title': 'Gruppo di risorse creato',
  'n.rgCreated.body': '{actor} ha creato il gruppo di risorse «{name}» ({location}).',
  'n.rgDeleted.title': 'Gruppo di risorse eliminato',
  'n.rgDeleted.body': '{actor} ha eliminato il gruppo di risorse «{name}» e tutte le sue risorse.',
  'n.resourceCreated.title': 'Risorsa creata',
  'n.resourceCreated.body': '{actor} ha creato {type} «{name}» in {rg}.',
  'n.resourceDeleted.title': 'Risorsa eliminata',
  'n.resourceDeleted.body': '{actor} ha eliminato {type} «{name}» da {rg}.',
  'n.roleAssigned.title': 'Nuova assegnazione di ruolo',
  'n.roleAssigned.body': '{actor} ha assegnato il ruolo {role} a {principal} su {scope}.',
  'n.roleAssignedToYou.title': 'Ti è stato assegnato un ruolo',
  'n.roleAssignedToYou.body': 'Hai ora il ruolo {role} su {scope}.',
  'n.dirRoleAssigned.title': 'Ruolo di directory assegnato',
  'n.dirRoleAssigned.body': '{actor} ha assegnato il ruolo {role} a {principal}.',
  'n.appCreated.title': 'Registrazione app creata',
  'n.appCreated.body': '{actor} ha registrato l\'applicazione «{app}».',
  'n.secretCreated.title': 'Nuovo segreto client',
  'n.secretCreated.body': '{actor} ha aggiunto il segreto «{name}» all\'applicazione «{app}». Scade il {date}.',
  'n.budgetThreshold.title': 'Budget «{name}» al {pct}%',
  'n.budgetThreshold.body': 'Spesa stimata del mese: {spent} {currency} su {amount} {currency} (soglia {threshold}%).',
  'n.budgetForecast.title': 'Budget «{name}»: previsione al {pct}%',
  'n.budgetForecast.body': 'A fine mese la spesa stimata arriverà a {spent} {currency} su {amount} {currency} (soglia {threshold}%).',
  'n.secretExpiring.title': 'Credenziale in scadenza',
  'n.secretExpiring.body': 'La credenziale «{name}» dell\'applicazione «{app}» scade il {date}.',
  'n.signInFailed.title': 'Accesso non riuscito',
  'n.signInFailed.body': 'Tentativo di accesso non riuscito per {upn} da {ip}.',
  'n.passwordReset.title': 'Password reimpostata',
  'n.passwordReset.body': '{actor} ha reimpostato la tua password.',
  'n.test.title': 'Notifica di prova',
  'n.test.body': 'Le notifiche push di Azzurro funzionano su questo dispositivo.',
  'n.unknownActor': 'Qualcuno',
  // pagine di login
  'l.title': 'Accedi',
  'l.subtitle': 'Usa il tuo account aziendale',
  'l.username': 'Indirizzo e-mail o nome utente',
  'l.password': 'Password',
  'l.signin': 'Accedi',
  'l.continueTo': 'per continuare in {app}',
  'l.invalid': 'Nome utente o password non corretti.',
  'l.disabled': 'L\'account è disabilitato. Contatta l\'amministratore.',
  'l.mustChange': 'Devi aggiornare la password perché è il primo accesso o è stata reimpostata.',
  'l.newPassword': 'Nuova password',
  'l.confirmPassword': 'Conferma password',
  'l.update': 'Aggiorna password',
  'l.mismatch': 'Le password non coincidono.',
  'l.weak': 'La password deve avere almeno 8 caratteri e contenere 3 tra: minuscole, maiuscole, numeri, simboli.',
  'l.deviceTitle': 'Immetti il codice',
  'l.deviceSubtitle': 'Immetti il codice visualizzato nell\'app o nel dispositivo per consentire l\'accesso.',
  'l.code': 'Codice',
  'l.next': 'Avanti',
  'l.badCode': 'Il codice non è valido o è scaduto.',
  'l.deviceDone': 'Accesso completato',
  'l.deviceDoneText': 'Hai effettuato l\'accesso a {app} sul dispositivo. Puoi chiudere questa finestra.',
  'l.signedOut': 'Disconnessione completata',
  'l.signedOutText': 'Puoi chiudere questa finestra.',
  'l.error': 'Si è verificato un errore',
  'l.lang': 'English',
  'l.footer': 'Azzurro · emulatore locale di Microsoft Entra ID',
};

const en: Dict = {
  'n.operationSucceeded.title': 'Operation completed',
  'n.operationSucceeded.body': '{title}: completed.',
  'n.operationFailed.title': 'Operation failed',
  'n.operationFailed.body': '{title}: {error}',
  'n.operationCanceled.title': 'Operation canceled',
  'n.operationCanceled.body': '{title}: canceled.',
  'n.deploymentSucceeded.title': 'Deployment succeeded',
  'n.deploymentSucceeded.body': 'Deployment “{name}” in {scope} completed successfully.',
  'n.deploymentFailed.title': 'Deployment failed',
  'n.deploymentFailed.body': 'Deployment “{name}” in {scope} failed: {error}',
  'n.rgCreated.title': 'Resource group created',
  'n.rgCreated.body': '{actor} created resource group “{name}” ({location}).',
  'n.rgDeleted.title': 'Resource group deleted',
  'n.rgDeleted.body': '{actor} deleted resource group “{name}” and all its resources.',
  'n.resourceCreated.title': 'Resource created',
  'n.resourceCreated.body': '{actor} created {type} “{name}” in {rg}.',
  'n.resourceDeleted.title': 'Resource deleted',
  'n.resourceDeleted.body': '{actor} deleted {type} “{name}” from {rg}.',
  'n.roleAssigned.title': 'New role assignment',
  'n.roleAssigned.body': '{actor} assigned the {role} role to {principal} on {scope}.',
  'n.roleAssignedToYou.title': 'You were assigned a role',
  'n.roleAssignedToYou.body': 'You now have the {role} role on {scope}.',
  'n.dirRoleAssigned.title': 'Directory role assigned',
  'n.dirRoleAssigned.body': '{actor} assigned the {role} role to {principal}.',
  'n.appCreated.title': 'App registration created',
  'n.appCreated.body': '{actor} registered the application “{app}”.',
  'n.secretCreated.title': 'New client secret',
  'n.secretCreated.body': '{actor} added the secret “{name}” to the application “{app}”. It expires on {date}.',
  'n.budgetThreshold.title': 'Budget “{name}” at {pct}%',
  'n.budgetThreshold.body': 'Estimated spend this month: {spent} {currency} of {amount} {currency} (threshold {threshold}%).',
  'n.budgetForecast.title': 'Budget “{name}”: forecast at {pct}%',
  'n.budgetForecast.body': 'Estimated spend will reach {spent} {currency} of {amount} {currency} by month end (threshold {threshold}%).',
  'n.secretExpiring.title': 'Credential expiring',
  'n.secretExpiring.body': 'The credential “{name}” of the application “{app}” expires on {date}.',
  'n.signInFailed.title': 'Failed sign-in',
  'n.signInFailed.body': 'A sign-in attempt for {upn} from {ip} failed.',
  'n.passwordReset.title': 'Password reset',
  'n.passwordReset.body': '{actor} reset your password.',
  'n.test.title': 'Test notification',
  'n.test.body': 'Azzurro push notifications are working on this device.',
  'n.unknownActor': 'Someone',
  'l.title': 'Sign in',
  'l.subtitle': 'Use your work account',
  'l.username': 'Email address or username',
  'l.password': 'Password',
  'l.signin': 'Sign in',
  'l.continueTo': 'to continue to {app}',
  'l.invalid': 'Your username or password is incorrect.',
  'l.disabled': 'Your account has been disabled. Contact your administrator.',
  'l.mustChange': 'You need to update your password because this is your first sign-in or it was reset.',
  'l.newPassword': 'New password',
  'l.confirmPassword': 'Confirm password',
  'l.update': 'Update password',
  'l.mismatch': 'The passwords do not match.',
  'l.weak': 'The password must be at least 8 characters and contain 3 of: lowercase, uppercase, numbers, symbols.',
  'l.deviceTitle': 'Enter code',
  'l.deviceSubtitle': 'Enter the code displayed on your app or device to allow access.',
  'l.code': 'Code',
  'l.next': 'Next',
  'l.badCode': 'The code is invalid or has expired.',
  'l.deviceDone': 'You are signed in',
  'l.deviceDoneText': 'You have signed in to {app} on your device. You can close this window.',
  'l.signedOut': 'You signed out',
  'l.signedOutText': 'You can close this window.',
  'l.error': 'Something went wrong',
  'l.lang': 'Italiano',
  'l.footer': 'Azzurro · local Microsoft Entra ID emulator',
};

const dicts: Record<Locale, Dict> = { it, en };

export function t(locale: Locale, key: string, params: Record<string, unknown> = {}): string {
  const s = dicts[locale][key] ?? dicts.it[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, p) => (params[p] === undefined ? `{${p}}` : String(params[p])));
}

export function formatDate(locale: Locale, iso: string): string {
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { dateStyle: 'medium' }).format(new Date(iso));
}
