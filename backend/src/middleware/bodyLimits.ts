import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Rutas que leen su cuerpo en su montaje, después de autenticar.
export const LARGE_BODY_ROUTES = /^\/api\/(attachments|branding|backup\/import)(\/|$)/i;

const OPEN_BRACE = 0x7b;
const OPEN_BRACKET = 0x5b;

/**
 * Parser JSON con tope de tamaño y de objetos. El tamaño no basta: un JSON de 12 MB lleno
 * de `{},` ocupa cientos de MB al parsearlo. El tope se cuenta antes de parsear. Tampoco lee
 * el cuerpo de un GET: esas peticiones no pasan por el cupo.
 */
export function boundedJson({ limit, maxContainers }: { limit: string; maxContainers: number }): RequestHandler {
  const parser = express.json({
    limit,
    verify: (_req, _res, buf) => {
      let containers = 0;
      for (const byte of buf) {
        if ((byte === OPEN_BRACE || byte === OPEN_BRACKET) && ++containers > maxContainers) {
          throw Object.assign(new Error('El contenido tiene demasiados elementos.'), { status: 413 });
        }
      }
    }
  });
  return (req, res, next) => (BODYLESS.has(req.method) ? next() : parser(req, res, next));
}

/**
 * Limita cuántas peticiones con cuerpo grande se procesan a la vez en este proceso.
 * El contenedor tiene poca memoria: varios cuerpos grandes juntos lo tumban aunque
 * cada uno respete su límite de tamaño.
 *
 * Por defecto el cupo se libera al cerrar la conexión. Un trabajo que sigue aunque el cliente
 * se vaya debe llamar a `holdBodyGate` al empezar y liberar con la función que devuelve.
 */
export function createBodyGate(max: number, message: string): RequestHandler {
  let inFlight = 0;
  return (req: Request, res: Response, next: NextFunction) => {
    if (BODYLESS.has(req.method)) return next();
    if (inFlight >= max) {
      res.setHeader('Retry-After', '5');
      return res.status(429).json({ message });
    }
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    res.locals.bodyGate = { release, held: false };
    res.once('close', () => { if (!res.locals.bodyGate.held) release(); });
    return next();
  };
}

export function holdBodyGate(res: Response): () => void {
  res.locals.bodyGate.held = true;
  return res.locals.bodyGate.release;
}

/** Evita el parser global en las rutas que leen su cuerpo después de autenticar. */
export function skipBodyFor(pattern: RegExp, parser: RequestHandler): RequestHandler {
  return (req, res, next) => (pattern.test(req.path) ? next() : parser(req, res, next));
}
