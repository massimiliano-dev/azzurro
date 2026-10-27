import type { Context } from 'hono';

export interface Principal {
  kind: 'user' | 'app';
  /** object id dell'utente o del service principal */
  oid: string;
  tid: string;
  /** app client usata (per i token utente) o appId del service principal (per i token app) */
  appId?: string;
  upn?: string;
  name: string;
  /** ruoli applicativi presenti nel token (permessi "Application") */
  roles: string[];
  /** scope delegati presenti nel token */
  scopes: string[];
  via: 'token' | 'session' | 'lax';
  sessionId?: string;
}

export type AppEnv = {
  Variables: {
    principal: Principal;
    requestId: string;
  };
};

export type Ctx = Context<AppEnv>;
