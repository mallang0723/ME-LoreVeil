// ──────────────────────────────────────────────
// Request logging: one id per request, on every line it causes
// ──────────────────────────────────────────────
// Fastify gives req.log a request id, but lines written through the shared
// `logger` from a service called by that request carried nothing. These hooks
// put the id into the log context (log-context.ts) for the whole request, so
// both kinds of line carry `requestId`, and echo it to the client as
// `x-request-id` so a bug report can quote it.
// ──────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import { LogController } from "fastify";
import { runWithRootLogContext } from "./log-context.js";
export const REQUEST_ID_HEADER = "x-request-id";
const INCOMING_REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;
const kLogContext = Symbol("marinara.logContext");
/** Accepts a client-supplied x-request-id only when it is a plain 8 to 80 character token. */
export function sanitizeIncomingRequestId(value) {
    return typeof value === "string" && INCOMING_REQUEST_ID.test(value) ? value : undefined;
}
/**
 * Fastify genReqId: a well-formed client x-request-id is kept for end-to-end
 * tracing, otherwise a UUID (the default "req-1" counter restarts every boot).
 */
export function genRequestId(req) {
    return sanitizeIncomingRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();
}
/** The matched route pattern ("/api/chats/:id"), so ids and query strings stay out of log lines. */
export function routeLabel(request) {
    return request.routeOptions?.url ?? "<unmatched>";
}
/** The request path without its query string or fragment. */
export function pathWithoutQuery(url) {
    return url.split(/[?#]/, 1)[0] ?? url;
}
/**
 * Fastify's request fields for the "incoming request" line, in the shape its
 * default `req` serializer reads, with the query string left out of `url`.
 */
function requestForLog(request) {
    return {
        method: request.method,
        url: pathWithoutQuery(request.url),
        headers: { "accept-version": request.headers["accept-version"] },
        host: request.host,
        ip: request.ip,
        socket: { remotePort: request.socket?.remotePort },
    };
}
/**
 * Fastify's LogController with the request id labelled `requestId` (Fastify's
 * default label is `reqId`) and query strings (which can carry tokens or
 * search text) left out of the "incoming request" and "not found" lines.
 * The incoming line keeps Fastify's `req` fields (method, url, version, host,
 * remoteAddress, remotePort) and adds `route`. Everything else is Fastify's
 * default, including LOG_DISABLE_REQUEST_LOGGING.
 */
export class RequestLogController extends LogController {
    constructor(options = {}) {
        super({ ...options, requestIdLogLabel: "requestId" });
    }
    incomingRequest(request) {
        if (this.isLogDisabled(request))
            return;
        request.log.info({ req: requestForLog(request), route: routeLabel(request) }, "incoming request");
    }
    routeNotFound(request) {
        if (this.isLogDisabled(request))
            return;
        request.log.info("Route %s:%s not found", request.method, pathWithoutQuery(request.url));
    }
    /** Logged when the client closes a request before the reply; off with the other request lines. */
    clientAborted(request) {
        if (this.isLogDisabled(request))
            return;
        request.log.info({ method: request.method, route: routeLabel(request) }, "Client aborted request");
    }
}
/**
 * Registers the request id trail. Call right after creating the Fastify
 * instance so the context is in place before any other hook runs. Pass the
 * app's RequestLogController so the abort line follows
 * LOG_DISABLE_REQUEST_LOGGING like the other request lines.
 */
export function registerRequestLogging(app, logController) {
    app.addHook("onRequest", (request, reply, done) => {
        reply.header(REQUEST_ID_HEADER, request.id);
        const context = { requestId: request.id };
        request[kLogContext] = context;
        // A fresh root: a keep-alive socket must not leak the previous request's id.
        runWithRootLogContext(context, done);
    });
    // Body parsing runs in the HTTP parser's async context, so the handler would
    // otherwise lose the id on requests with a body. Rebind before validation.
    app.addHook("preValidation", (request, _reply, done) => {
        const context = request[kLogContext] ?? { requestId: request.id };
        runWithRootLogContext({ ...context, route: routeLabel(request) }, done);
    });
    const aborts = logController ?? new RequestLogController();
    app.addHook("onRequestAbort", (request, done) => {
        aborts.clientAborted(request);
        done();
    });
}
