/**
 * Centralized port configuration for AboardAI
 *
 * These ports are reserved for the AboardAI application and should never be
 * killed or terminated by AI agents during feature implementation.
 */

/** Port for the static/UI server (Vite dev server) */
export const STATIC_PORT = 47821;

/** Port for the backend API server (Express + WebSocket) */
export const SERVER_PORT = 47820;

/** Array of all reserved AboardAI ports */
export const RESERVED_PORTS = [STATIC_PORT, SERVER_PORT] as const;
