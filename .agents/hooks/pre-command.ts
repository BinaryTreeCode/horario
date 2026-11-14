/**
 * Hook PreToolUse para Antigravity en Nature Planner.
 * Intercepta ejecuciones de 'run_command' para aplicar guardrails de seguridad.
 */

import { leerStdin } from './shared';

export type EvaluacionComando = {
  decision: 'deny' | 'force_ask' | 'ask';
  reason?: string;
};

/**
 * Limpia los mensajes entre comillas o argumentos de git commit / git tag
 * para evitar falsos positivos cuando un commit menciona npm, npx o .env.local.
 */
export function limpiarMensajesGit(cmd: string): string {
  return cmd.replace(
    /(?:^|\s)(?:-(?:[a-zA-Z]{0,2}m\b)|--message\b)(?:=|\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi,
    ' '
  );
}

const NPM_INVOCATION_REGEX =
  /(?:^|[;&|`\n(]|\bcmd(?:\.exe)?\s+\/[ck]\s+|\bpowershell(?:\.exe)?\s+-(?:c|command)\s+["']?)\s*(?:[\w.-]+=\S+\s+)*(?:npm|npx)(?:\.(?:cmd|exe|bat|ps1))?(?![\w-])/i;

const ENV_READ_CMD_REGEX =
  /\b(?:cat|type|get-content|gc|more|less|head|tail|select-string|grep|rg|sed|awk|readFile|readFileSync)\b|Bun\.file|<\s*["']?\.env\.local/i;

const ENV_FILE_REGEX = /\.env\.local\b(?!\.example)/i;

const DB_PRINT_CMD_REGEX =
  /\b(?:echo|write-output|write-host|printenv)\b|(?:gci|get-childitem|dir)\s+env:/i;

const DB_URL_REGEX = /DATABASE_URL/i;

const CRITICAL_FORCE_ASK_REGEX =
  /\b(?:drizzle-kit\s+push|db:push)\b|\bgit\b[^;&|\n`]*\bpush\b[^;&|\n`]*(?:\s-(?:[a-zA-Z]*f\b)|--force\b|\+[\w/]+)|\bgit\b[^;&|\n`]*\breset\b[^;&|\n`]*\s+--hard\b/i;

/**
 * Evalúa un comando de shell según los guardrails de Nature Planner.
 */
export function evaluarComando(cmd: string): EvaluacionComando {
  if (!cmd || typeof cmd !== 'string') {
    return { decision: 'ask' };
  }

  const cmdLimpio = limpiarMensajesGit(cmd);

  // 1. Regla deny: npm / npx
  if (NPM_INVOCATION_REGEX.test(cmdLimpio)) {
    return {
      decision: 'deny',
      reason: 'El uso de npm/npx está prohibido en Nature Planner (proyecto 100% bun). Usa bun o bunx.',
    };
  }

  // 2. Regla deny: lectura o filtrado directo / programático de .env.local
  if (ENV_FILE_REGEX.test(cmdLimpio) && ENV_READ_CMD_REGEX.test(cmdLimpio)) {
    return {
      decision: 'deny',
      reason: 'Lectura o filtrado directo de .env.local prohibido para proteger credenciales y DATABASE_URL.',
    };
  }

  // 3. Regla deny: impresión o exposición de DATABASE_URL
  if (DB_URL_REGEX.test(cmdLimpio) && DB_PRINT_CMD_REGEX.test(cmdLimpio)) {
    return {
      decision: 'deny',
      reason: 'Impresión o exposición de DATABASE_URL prohibida para proteger credenciales de base de datos.',
    };
  }

  // 4. Regla force_ask: operaciones críticas de base de datos o historia remota
  if (CRITICAL_FORCE_ASK_REGEX.test(cmdLimpio)) {
    return {
      decision: 'force_ask',
      reason: 'Operación crítica detectada (migración de DB, git push forzado o reset --hard). Requiere confirmación explícita.',
    };
  }

  // 5. Regla ask: cualquier otro comando (nunca allow por defecto)
  return { decision: 'ask' };
}

if (import.meta.main) {
  let decision: EvaluacionComando = { decision: 'ask' };
  try {
    const raw = await leerStdin();
    if (raw && raw.trim()) {
      const parsed = JSON.parse(raw);
      const cmd = parsed?.toolCall?.args?.CommandLine ?? parsed?.toolCall?.args?.commandLine ?? '';
      decision = evaluarComando(cmd);
    }
  } catch {
    decision = { decision: 'ask' };
  }

  console.log(JSON.stringify(decision, null, 2));
  process.exit(0);
}
