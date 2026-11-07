// runner/authsignal.mjs: classify a rejected key from a session error and the codearts server log.
// Returns null (not an auth problem) or { key: 'aksk' | 'maas', message } so the lane can stop at
// once with a plain-words message that names the key and the fix. No secrets are ever inspected here:
// only the sign-in status lines and the error text are matched.

const AKSK_MSG = 'CodeArts could not sign in with your AK/SK (wrong or disabled keys, or Huawei IAM is down). Run ca auth --force to enter them again.';
const MAAS_MSG = 'The ModelArts MaaS API key was rejected. Run ca auth --force to enter it again (or remove it to use the CodeArts quota models).';

// An ERROR line for the auth service means the AK/SK could not sign in, whatever the model call that
// surfaced afterwards says (a plain-looking 503 is only a symptom).
const AKSK_LOG = /ERROR[^\n]*service=auth/i;
// A MaaS model refusing the bearer key.
const MAAS_ERR = /invalid\s+authorization|unauthorized|\b401\b|\b403\b/i;

export function authProblem({ model, error, serverLog } = {}) {
  const log = typeof serverLog === 'string' ? serverLog : '';
  const err = typeof error === 'string' ? error : '';
  const mdl = typeof model === 'string' ? model : '';
  if (AKSK_LOG.test(log)) return { key: 'aksk', message: AKSK_MSG };
  if (mdl.startsWith('maas/') && MAAS_ERR.test(err)) return { key: 'maas', message: MAAS_MSG };
  return null;
}
