/** Parametri server predefiniti di PostgreSQL e MySQL flessibili (sottoinsieme dei più usati). */
export interface ServerParam {
  name: string;
  value: string;
  dataType: 'Boolean' | 'Integer' | 'Enumeration' | 'String' | 'Numeric' | 'Set';
  allowedValues: string;
  description: string;
  isDynamicConfig: boolean;
  isReadOnly?: boolean;
  unit?: string;
}

const P = (name: string, value: string, dataType: ServerParam['dataType'], allowedValues: string, description: string, isDynamicConfig = true, unit?: string, isReadOnly = false): ServerParam =>
  ({ name, value, dataType, allowedValues, description, isDynamicConfig, unit, isReadOnly });

export const PG_PARAMS: ServerParam[] = [
  P('max_connections', '50', 'Integer', '25-5000', 'Maximum number of concurrent connections.', false),
  P('shared_buffers', '16384', 'Integer', '16-1073741823', 'Memory used by the server for shared buffers.', false, '8KB'),
  P('work_mem', '4096', 'Integer', '4096-2097151', 'Memory used by internal sort operations and hash tables before writing to temporary disk files.', true, 'KB'),
  P('maintenance_work_mem', '65536', 'Integer', '1024-2097151', 'Maximum memory used by maintenance operations.', true, 'KB'),
  P('effective_cache_size', '196608', 'Integer', '1-2147483647', 'Planner assumption about the effective size of the disk cache.', true, '8KB'),
  P('timezone', 'UTC', 'String', '[A-Za-z0-9/+_-]+', 'Time zone for displaying and interpreting time stamps.'),
  P('log_min_duration_statement', '-1', 'Integer', '-1-2147483647', 'Logs every statement that runs at least this many milliseconds; -1 disables.', true, 'ms'),
  P('log_connections', 'on', 'Boolean', 'on,off', 'Logs each successful connection.'),
  P('log_disconnections', 'off', 'Boolean', 'on,off', 'Logs end of a session, including duration.'),
  P('log_checkpoints', 'on', 'Boolean', 'on,off', 'Logs each checkpoint.'),
  P('idle_in_transaction_session_timeout', '0', 'Integer', '0-2147483647', 'Terminates sessions idle within an open transaction for longer than this.', true, 'ms'),
  P('statement_timeout', '0', 'Integer', '0-2147483647', 'Aborts any statement that takes more than this.', true, 'ms'),
  P('lock_timeout', '0', 'Integer', '0-2147483647', 'Aborts any statement that waits longer than this for a lock.', true, 'ms'),
  P('random_page_cost', '2', 'Numeric', '0-1.79769e+308', 'Planner estimate of the cost of a non-sequentially fetched disk page.'),
  P('default_statistics_target', '100', 'Integer', '1-10000', 'Default statistics target for table columns.'),
  P('autovacuum', 'on', 'Boolean', 'on,off', 'Starts the autovacuum subprocess.'),
  P('autovacuum_naptime', '60', 'Integer', '1-2147483', 'Time to sleep between autovacuum runs.', true, 's'),
  P('autovacuum_vacuum_scale_factor', '0.2', 'Numeric', '0-100', 'Fraction of table size before vacuum.'),
  P('azure.extensions', '', 'Set', 'address_standardizer,amcheck,azure_ai,azure_storage,bloom,btree_gin,btree_gist,citext,cube,dblink,fuzzystrmatch,hstore,intarray,isn,lo,ltree,pg_buffercache,pg_cron,pg_partman,pg_prewarm,pg_stat_statements,pg_trgm,pgaudit,pgcrypto,pgvector,plpgsql,postgis,postgres_fdw,tablefunc,unaccent,uuid-ossp,vector', 'Extensions allowed to be created in the server.'),
  P('shared_preload_libraries', 'pg_cron,pg_stat_statements', 'Set', 'auto_explain,azure_storage,pg_cron,pg_failover_slots,pg_hint_plan,pg_partman_bgw,pg_prewarm,pg_squeeze,pg_stat_statements,pgaudit,pglogical,timescaledb,wal2json', 'Shared libraries to preload into the server.', false),
  P('require_secure_transport', 'on', 'Boolean', 'on,off', 'Whether client connections must use SSL/TLS.'),
  P('ssl_min_protocol_version', 'TLSv1.2', 'Enumeration', 'TLSv1.2,TLSv1.3', 'Minimum SSL/TLS protocol version.'),
  P('password_encryption', 'scram-sha-256', 'Enumeration', 'md5,scram-sha-256', 'Algorithm used to encrypt passwords.'),
  P('pgbouncer.enabled', 'false', 'Boolean', 'true,false', 'Enables the built-in PgBouncer connection pooler.'),
  P('pg_qs.query_capture_mode', 'none', 'Enumeration', 'none,top,all', 'Query Store capture mode.'),
  P('server_version', '16', 'String', '', 'Server version.', false, undefined, true),
];

export const MYSQL_PARAMS: ServerParam[] = [
  P('max_connections', '341', 'Integer', '10-5000', 'Maximum permitted number of simultaneous client connections.'),
  P('innodb_buffer_pool_size', '536870912', 'Integer', '134217728-4294967296', 'Size of the InnoDB buffer pool.', false, 'bytes'),
  P('time_zone', 'SYSTEM', 'String', '[+-]HH:MM|SYSTEM|named', 'Server time zone.'),
  P('character_set_server', 'utf8mb4', 'Enumeration', 'big5,dec8,cp850,hp8,koi8r,latin1,latin2,swe7,ascii,ujis,sjis,hebrew,tis620,euckr,koi8u,gb2312,greek,cp1250,gbk,latin5,armscii8,utf8,ucs2,cp866,keybcs2,macce,macroman,cp852,latin7,utf8mb4,cp1251,utf16,cp1256,cp1257,utf32,binary,geostd8,cp932,eucjpms', 'Server default character set.'),
  P('collation_server', 'utf8mb4_0900_ai_ci', 'String', '', 'Server default collation.'),
  P('sql_mode', 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION', 'Set', 'ALLOW_INVALID_DATES,ANSI_QUOTES,ERROR_FOR_DIVISION_BY_ZERO,HIGH_NOT_PRECEDENCE,IGNORE_SPACE,NO_AUTO_VALUE_ON_ZERO,NO_BACKSLASH_ESCAPES,NO_DIR_IN_CREATE,NO_ENGINE_SUBSTITUTION,NO_UNSIGNED_SUBTRACTION,NO_ZERO_DATE,NO_ZERO_IN_DATE,ONLY_FULL_GROUP_BY,PAD_CHAR_TO_FULL_LENGTH,PIPES_AS_CONCAT,REAL_AS_FLOAT,STRICT_ALL_TABLES,STRICT_TRANS_TABLES,TIME_TRUNCATE_FRACTIONAL', 'SQL modes for the server.'),
  P('wait_timeout', '28800', 'Integer', '1-31536000', 'Seconds the server waits for activity on a noninteractive connection.', true, 's'),
  P('interactive_timeout', '28800', 'Integer', '1-31536000', 'Seconds the server waits for activity on an interactive connection.', true, 's'),
  P('slow_query_log', 'OFF', 'Enumeration', 'ON,OFF', 'Enables the slow query log.'),
  P('long_query_time', '10', 'Numeric', '0-1e100', 'Queries slower than this are written to the slow query log.', true, 's'),
  P('require_secure_transport', 'ON', 'Enumeration', 'ON,OFF', 'Whether client connections must use encrypted transport.'),
  P('tls_version', 'TLSv1.2', 'Set', 'TLSv1.2,TLSv1.3', 'Allowed TLS protocol versions.', false),
  P('event_scheduler', 'OFF', 'Enumeration', 'ON,OFF', 'Enables the event scheduler.'),
  P('lower_case_table_names', '1', 'Integer', '1-2', 'Whether table names are stored in lowercase.', false),
  P('max_allowed_packet', '536870912', 'Integer', '1024-1073741824', 'Maximum size of one packet.', true, 'bytes'),
  P('innodb_lock_wait_timeout', '50', 'Integer', '1-3600', 'Seconds an InnoDB transaction waits for a row lock.', true, 's'),
  P('log_bin_trust_function_creators', 'OFF', 'Enumeration', 'ON,OFF', 'Whether stored function creators are trusted.'),
  P('version', '8.0.21', 'String', '', 'Server version.', false, undefined, true),
];

export function paramsFor(type: string): ServerParam[] {
  return /mysql/i.test(type) ? MYSQL_PARAMS : PG_PARAMS;
}

export function validateParam(p: ServerParam, value: string): string | null {
  if (p.isReadOnly) return `The parameter '${p.name}' is read-only.`;
  if (p.dataType === 'Boolean' || p.dataType === 'Enumeration') {
    const allowed = p.allowedValues.split(',');
    if (!allowed.some((a) => a.toLowerCase() === value.toLowerCase())) return `The value '${value}' for '${p.name}' is not valid. Allowed values: ${p.allowedValues}.`;
  }
  if (p.dataType === 'Set' && value) {
    const allowed = new Set(p.allowedValues.split(',').map((a) => a.toLowerCase()));
    const bad = value.split(',').map((v) => v.trim()).filter((v) => v && !allowed.has(v.toLowerCase()));
    if (bad.length) return `The values '${bad.join(',')}' for '${p.name}' are not allowed.`;
  }
  if (p.dataType === 'Integer' || p.dataType === 'Numeric') {
    const n = Number(value);
    const m = /^(-?[\d.e+]+)-(-?[\d.e+]+)$/.exec(p.allowedValues);
    if (!Number.isFinite(n) || (p.dataType === 'Integer' && !Number.isInteger(n))) return `The value '${value}' for '${p.name}' must be a ${p.dataType === 'Integer' ? 'whole ' : ''}number.`;
    if (m && (n < Number(m[1]) || n > Number(m[2]))) return `The value '${value}' for '${p.name}' must be between ${m[1]} and ${m[2]}.`;
  }
  return null;
}

export function paramView(serverId: string, type: string, p: ServerParam, stored?: any): any {
  const value = stored?.properties?.value ?? p.value;
  return {
    id: `${serverId}/configurations/${p.name}`,
    name: p.name,
    type: `${type}/configurations`,
    properties: {
      value, defaultValue: p.value, description: p.description, dataType: p.dataType, allowedValues: p.allowedValues,
      source: stored && value !== p.value ? 'user-override' : 'system-default', isDynamicConfig: p.isDynamicConfig, isReadOnly: !!p.isReadOnly,
      isConfigPendingRestart: !!stored && !p.isDynamicConfig && value !== p.value, unit: p.unit ?? null, documentationLink: null,
    },
  };
}
