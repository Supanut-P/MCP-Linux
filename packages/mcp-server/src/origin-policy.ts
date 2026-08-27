import { localhostAllowedOrigins, originValidationResponse } from '@modelcontextprotocol/server';

export interface OriginPolicy {
  validate(request: Request): Response | undefined;
}

export function createOriginPolicy(allowedHostnames: readonly string[] = localhostAllowedOrigins()): OriginPolicy {
  const allowed = [...new Set(allowedHostnames)];
  return {
    validate(request: Request): Response | undefined {
      return originValidationResponse(request, allowed);
    },
  };
}
