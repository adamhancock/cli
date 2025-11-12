import { CaddyConfig, CaddyHost } from '../types';

const CADDY_API_URL = 'http://localhost:2019';

/**
 * Fetch the current Caddy configuration
 */
export async function fetchCaddyConfig(): Promise<CaddyConfig | null> {
  try {
    const response = await fetch(`${CADDY_API_URL}/config/`);

    if (!response.ok) {
      throw new Error(`Caddy API returned ${response.status}`);
    }

    const data = await response.json() as CaddyConfig;
    return data;
  } catch (error) {
    // Caddy might not be running, return null
    console.error('Failed to fetch Caddy config:', error);
    return null;
  }
}

/**
 * Extract hosts from Caddy configuration
 */
export function extractHosts(config: CaddyConfig): CaddyHost[] {
  const hosts: CaddyHost[] = [];
  const seenHosts = new Set<string>();

  if (config.apps?.http?.servers) {
    for (const [serverName, server] of Object.entries(config.apps.http.servers)) {
      if (server.routes) {
        for (const route of server.routes) {
          if (route.match) {
            for (const match of route.match) {
              if (match.host) {
                for (const host of match.host) {
                  if (!seenHosts.has(host)) {
                    seenHosts.add(host);

                    // Determine protocol
                    const protocol = serverName.includes('https') || serverName === 'srv1' ? 'https' : 'http';

                    // Extract upstreams and worktree path from route handlers
                    const upstreams: Set<string> = new Set();
                    let worktreePath: string | undefined;

                    const extractData = (handlers: unknown[]) => {
                      if (!handlers) return;

                      for (const handler of handlers) {
                        const h = handler as Record<string, unknown>;

                        // Direct reverse proxy
                        if (h.handler === 'reverse_proxy') {
                          if (Array.isArray(h.upstreams)) {
                            for (const upstream of h.upstreams) {
                              const u = upstream as Record<string, unknown>;
                              if (typeof u.dial === 'string') {
                                upstreams.add(u.dial);
                              }
                            }
                          }

                          // Extract worktree path from headers
                          const headers = h.headers as Record<string, unknown>;
                          if (headers?.response) {
                            const responseHeaders = headers.response as Record<string, unknown>;
                            if (responseHeaders.set) {
                              const setHeaders = responseHeaders.set as Record<string, string[]>;
                              if (setHeaders['X-Worktree-Path']?.[0]) {
                                worktreePath = setHeaders['X-Worktree-Path'][0];
                              }
                            }
                          }
                        }
                        // Subroute handler
                        else if (h.handler === 'subroute' && Array.isArray(h.routes)) {
                          for (const subroute of h.routes) {
                            const sr = subroute as Record<string, unknown>;
                            if (Array.isArray(sr.handle)) {
                              extractData(sr.handle);
                            }
                          }
                        }
                      }
                    };

                    if (route.handle) {
                      extractData(route.handle);
                    }

                    hosts.push({
                      name: host,
                      url: `${protocol}://${host}`,
                      upstreams: upstreams.size > 0 ? Array.from(upstreams) : undefined,
                      worktreePath,
                      routes: route.handle
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return hosts.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find a Caddy host by worktree path
 */
export async function findHostByWorktreePath(worktreePath: string): Promise<CaddyHost | null> {
  const config = await fetchCaddyConfig();

  if (!config) {
    return null;
  }

  const hosts = extractHosts(config);
  const normalizedPath = worktreePath.replace(/\/$/, ''); // Remove trailing slash

  return hosts.find(h => h.worktreePath?.replace(/\/$/, '') === normalizedPath) || null;
}

/**
 * Delete a host route from Caddy configuration
 */
export async function deleteHostRoute(hostName: string): Promise<boolean> {
  try {
    const config = await fetchCaddyConfig();

    if (!config || !config.apps?.http?.servers) {
      return false;
    }

    // Find the route to delete
    let routeFound = false;

    for (const [serverName, server] of Object.entries(config.apps.http.servers)) {
      if (server.routes) {
        // Go through routes in reverse order to track indices for deletion
        for (let i = server.routes.length - 1; i >= 0; i--) {
          const route = server.routes[i];
          if (route.match) {
            for (const match of route.match) {
              if (match.host && match.host.includes(hostName)) {
                // Found the route for this host
                routeFound = true;
                try {
                  const path = `/config/apps/http/servers/${serverName}/routes/${i}`;
                  const response = await fetch(`${CADDY_API_URL}${path}`, {
                    method: 'DELETE',
                  });

                  if (!response.ok) {
                    console.error(`Failed to delete route for ${hostName}: ${response.status}`);
                    return false;
                  }

                  console.log(`Deleted route for ${hostName} from server ${serverName}`);
                  return true;
                } catch (err) {
                  console.error(`Failed to delete route for ${hostName}:`, err);
                  return false;
                }
              }
            }
            if (routeFound) break;
          }
        }
        if (routeFound) break;
      }
    }

    if (!routeFound) {
      console.log(`No route found for ${hostName}`);
      return false;
    }

    return false;
  } catch (error) {
    console.error('Failed to delete route from Caddy configuration:', error);
    return false;
  }
}

/**
 * Delete a host route by worktree path
 */
export async function deleteRouteByWorktreePath(worktreePath: string): Promise<boolean> {
  const host = await findHostByWorktreePath(worktreePath);

  if (!host) {
    console.log(`No Caddy host found for worktree path: ${worktreePath}`);
    return false;
  }

  return await deleteHostRoute(host.name);
}
