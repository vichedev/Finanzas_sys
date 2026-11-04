// =====================================================
// Puente con el agente de actualización del host (deploy/update-agent.sh).
// El backend solo deja una señal ("check"/"apply") en el canal y lee el estado
// que el agente escribe. No ejecuta git ni docker (corre en un contenedor).
// =====================================================
import fs from 'fs';
import path from 'path';

const DIR = process.env.UPDATE_CHANNEL_DIR || '/app/.update-channel';
const p = (f: string) => path.join(DIR, f);

export function channelReady(): boolean {
  try { return fs.existsSync(DIR) && fs.statSync(DIR).isDirectory(); } catch { return false; }
}

function readFileSafe(f: string): string {
  try { return fs.readFileSync(p(f), 'utf8'); } catch { return ''; }
}
function parseKv(txt: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of txt.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export interface UpdateStatus {
  configured: boolean;
  agentAlive: boolean;       // el agente del host escribió latido recientemente
  version: string | null;    // commit actual (corto)
  state: string;             // idle | checking | updating | done | error | queued | unknown
  behind: number;            // commits por detrás del remoto
  commits: string[];         // asuntos de los commits nuevos
  checkedAt: string | null;
  updatedAt: string | null;
  error: string | null;
  pending: boolean;          // hay una señal sin procesar aún
  log: string;               // últimas líneas del log de la última actualización
}

export function readStatus(): UpdateStatus {
  const configured = channelReady();
  const hb = parseKv(readFileSafe('heartbeat'));
  const st = parseKv(readFileSafe('status'));
  const commits = readFileSafe('commits.txt').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const log = readFileSafe('update.log').split('\n').slice(-40).join('\n');
  const pending = (() => { try { return fs.existsSync(p('request')); } catch { return false; } })();

  // El agente vive si dejó latido en los últimos ~3 minutos.
  let agentAlive = false;
  if (hb.at) { const t = Date.parse(hb.at); agentAlive = Number.isFinite(t) && (Date.now() - t) < 3 * 60 * 1000; }

  return {
    configured,
    agentAlive,
    version: st.version || hb.version || null,
    state: pending ? 'queued' : (st.state || 'unknown'),
    behind: Number(st.behind || 0),
    commits,
    checkedAt: st.checkedAt || null,
    updatedAt: st.updatedAt || null,
    error: st.error || null,
    pending,
    log
  };
}

/** Deja una señal para el agente del host. */
export function requestAction(action: 'check' | 'apply'): { ok: true } | { ok: false; error: string } {
  if (!channelReady()) {
    return { ok: false, error: 'El actualizador no está configurado en el servidor (falta el agente del host).' };
  }
  try {
    fs.writeFileSync(p('request'), action);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.code === 'EACCES' ? 'Sin permisos para escribir en el canal (revisa los permisos de .update-channel).' : (e?.message || 'No se pudo encolar la acción.') };
  }
}
