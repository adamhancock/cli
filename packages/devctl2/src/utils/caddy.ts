import chalk from 'chalk';
import type { RouteInfo } from '../types.js';

// Internal interface for Caddy port configuration
interface CaddyPorts {
  api: number;
  web: number;
  spotlight?: number | null;
}

/**
 * Caddy API client for managing reverse proxy routes
 */
export class CaddyClient {
  private apiUrl: string;

  constructor(apiUrl: string = 'http://localhost:2019') {
    this.apiUrl = apiUrl;
  }

  /**
   * Make a request to Caddy's admin API
   */
  async request(method: string, endpoint: string, data: any = null): Promise<any> {
    const opts: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    if (data) {
      opts.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(`${this.apiUrl}${endpoint}`, opts);
      const text = await response.text();

      if (!text) return null;

      try {
        return JSON.parse(text);
      } catch (parseError) {
        throw new Error(`Failed to parse JSON response: ${(parseError as Error).message}\nResponse text: ${text}`);
      }
    } catch (error: any) {
      if (error.cause?.code === 'ECONNREFUSED') {
        throw new Error('Caddy is not running. Start it first or check your caddyApi configuration.');
      }
      throw error;
    }
  }

  /**
   * Check if Caddy server is properly configured
   */
  async checkServer(): Promise<boolean> {
    try {
      const config = await this.request('GET', '/config/');

      // Create srv0 if it doesn't exist
      if (!config?.apps?.http?.servers?.srv0) {
        console.log(chalk.yellow('⚠️  Caddy server srv0 not found, creating it...'));

        // Create the http app if it doesn't exist
        if (!config?.apps?.http) {
          await this.request('PUT', '/config/apps/http', {
            servers: {
              srv0: {
                listen: [':443'],
                automatic_https: {},
                routes: []
              }
            }
          });
        } else {
          // Just create srv0
          await this.request('PUT', '/config/apps/http/servers/srv0', {
            listen: [':443'],
            automatic_https: {},
            routes: []
          });
        }
        console.log(chalk.green('✅ Created srv0 server with HTTPS on port 443'));
      } else {
        // Check if srv0 has a listen directive, add it if missing
        const srv0Config = config.apps.http.servers.srv0;
        if (!srv0Config.listen || srv0Config.listen.length === 0) {
          console.log(chalk.yellow('⚠️  Caddy server not listening on any port, adding :443...'));
          await this.request('PATCH', '/config/apps/http/servers/srv0', { listen: [':443'] });
          console.log(chalk.green('✅ Added listen directive for port 443'));
        }
      }

      return true;
    } catch (error: any) {
      if (error.message?.includes('Caddy is not running')) {
        throw error;
      }
      throw new Error('Could not connect to Caddy API');
    }
  }

  /**
   * Get all routes from Caddy
   */
  async getRoutes(): Promise<any[]> {
    return await this.request('GET', '/config/apps/http/servers/srv0/routes') || [];
  }

  /**
   * Add or update a route for a subdomain
   */
  async addRoute(
    subdomain: string,
    ports: CaddyPorts,
    workdir: string,
    baseDomain: string,
    isRootDomain: boolean = false
  ): Promise<boolean> {
    // Ensure server is configured
    await this.checkServer();

    const hostname = isRootDomain ? baseDomain : `${subdomain}.${baseDomain}`;

    const route: any = {
      '@id': `route-${subdomain}`,
      match: [{ host: [hostname] }],
      handle: [{
        handler: 'subroute',
        routes: [
          {
            match: [{ path: ['/api/*'] }],
            handle: [{
              handler: 'reverse_proxy',
              upstreams: [{ dial: `127.0.0.1:${ports.api}` }],
              health_checks: {
                passive: {
                  unhealthy_request_count: 0
                }
              },
              headers: {
                response: {
                  set: {
                    'X-Worktree-Path': [workdir],
                    'X-Api-Port': [String(ports.api)],
                    'X-Web-Port': [String(ports.web)]
                  }
                }
              }
            }]
          },
          ...(ports.spotlight ? [{
            match: [{ path: ['/_spotlight', '/_spotlight/*'] }],
            handle: [
              {
                handler: 'rewrite',
                strip_path_prefix: '/_spotlight'
              },
              {
                handler: 'reverse_proxy',
                upstreams: [{ dial: `127.0.0.1:${ports.spotlight}` }],
                health_checks: {
                  passive: {
                    unhealthy_request_count: 0
                  }
                },
                headers: {
                  response: {
                    set: {
                      'X-Worktree-Path': [workdir],
                      'X-Spotlight-Port': [String(ports.spotlight)]
                    }
                  }
                }
              }
            ]
          }] : []),
          {
            handle: [{
              handler: 'reverse_proxy',
              upstreams: [{ dial: `127.0.0.1:${ports.web}` }],
              health_checks: {
                passive: {
                  unhealthy_request_count: 0
                }
              },
              headers: {
                response: {
                  set: {
                    'X-Worktree-Path': [workdir],
                    'X-Api-Port': [String(ports.api)],
                    'X-Web-Port': [String(ports.web)]
                  }
                }
              }
            }]
          }
        ]
      }],
      terminal: true
    };

    // Get existing routes and filter out the one we're replacing
    const existingRoutes = await this.getRoutes();
    const filteredRoutes = existingRoutes.filter(r => r['@id'] !== `route-${subdomain}`);

    // Add our new route at the beginning
    const newRoutes = [route, ...filteredRoutes];

    // Get the current server config to preserve other settings
    const serverConfig = await this.request('GET', '/config/apps/http/servers/srv0') || {};

    // Update the server configuration
    const updatedConfig = {
      ...serverConfig,
      listen: serverConfig.listen || [':443'],
      automatic_https: serverConfig.automatic_https || {},
      routes: newRoutes
    };

    // Add/update Spotlight UI server on port 8888 if spotlight is enabled
    if (ports.spotlight) {
      const spotlightServerKey = `spotlight-${subdomain}`;
      const spotlightServer = {
        listen: [':8888'],
        routes: [{
          '@id': `spotlight-ui-${subdomain}`,
          match: [{ host: [hostname] }],
          handle: [{
            handler: 'reverse_proxy',
            upstreams: [{ dial: `127.0.0.1:${ports.spotlight}` }],
            health_checks: {
              passive: {
                unhealthy_request_count: 0
              }
            },
            headers: {
              response: {
                set: {
                  'X-Worktree-Path': [workdir],
                  'X-Spotlight-Port': [String(ports.spotlight)]
                }
              }
            }
          }],
          terminal: true
        }]
      };

      await this.request('PUT', `/config/apps/http/servers/${spotlightServerKey}`, spotlightServer);
    }

    // Update the server configuration
    await this.request('PATCH', '/config/apps/http/servers/srv0', updatedConfig);

    return true;
  }

  /**
   * Add a standalone route for an app with a custom hostname
   * Optionally includes /api/* proxying to an API port
   */
  async addStandaloneRoute(
    routeId: string,
    hostname: string,
    port: number,
    workdir: string,
    apiPort?: number
  ): Promise<boolean> {
    // Ensure server is configured
    await this.checkServer();

    // Build route with optional API subroute
    const routes: any[] = [];

    // Add /api/* subroute if apiPort is provided
    if (apiPort) {
      routes.push({
        match: [{ path: ['/api/*'] }],
        handle: [{
          handler: 'reverse_proxy',
          upstreams: [{ dial: `127.0.0.1:${apiPort}` }],
          health_checks: {
            passive: {
              unhealthy_request_count: 0
            }
          },
          headers: {
            response: {
              set: {
                'X-Worktree-Path': [workdir],
                'X-Api-Port': [String(apiPort)]
              }
            }
          }
        }]
      });
    }

    // Add default route for the app
    routes.push({
      handle: [{
        handler: 'reverse_proxy',
        upstreams: [{ dial: `127.0.0.1:${port}` }],
        health_checks: {
          passive: {
            unhealthy_request_count: 0
          }
        },
        headers: {
          response: {
            set: {
              'X-Worktree-Path': [workdir],
              'X-App-Port': [String(port)]
            }
          }
        }
      }]
    });

    const route: any = {
      '@id': `route-${routeId}`,
      match: [{ host: [hostname] }],
      handle: [{
        handler: 'subroute',
        routes
      }],
      terminal: true
    };

    // Get existing routes and filter out the one we're replacing
    const existingRoutes = await this.getRoutes();
    const filteredRoutes = existingRoutes.filter(r => r['@id'] !== `route-${routeId}`);

    // Add our new route at the beginning
    const newRoutes = [route, ...filteredRoutes];

    // Get the current server config to preserve other settings
    const serverConfig = await this.request('GET', '/config/apps/http/servers/srv0') || {};

    // Update the server configuration
    const updatedConfig = {
      ...serverConfig,
      listen: serverConfig.listen || [':443'],
      automatic_https: serverConfig.automatic_https || {},
      routes: newRoutes
    };

    await this.request('PATCH', '/config/apps/http/servers/srv0', updatedConfig);

    return true;
  }

  /**
   * Remove a route by subdomain
   */
  async removeRoute(subdomain: string): Promise<boolean> {
    try {
      const routes = await this.getRoutes();
      if (routes) {
        for (let i = 0; i < routes.length; i++) {
          if (routes[i]['@id'] === `route-${subdomain}`) {
            await this.request('DELETE', `/config/apps/http/servers/srv0/routes/${i}`);
            console.log(chalk.green(`✅ Removed route for ${subdomain}`));
            return true;
          }
        }
      }
      console.log(chalk.yellow(`⚠️  No route found for ${subdomain}`));
      return false;
    } catch (error: any) {
      console.log(chalk.yellow(`⚠️  Failed to remove route: ${error.message}`));
      return false;
    }
  }

  /**
   * List all routes with metadata
   */
  async listRoutes(baseDomain: string): Promise<RouteInfo[]> {
    const routes = await this.getRoutes();

    console.log(chalk.blue('📋 Active Worktree Routes:\n'));
    console.log(chalk.gray('─'.repeat(120)));
    console.log(chalk.gray('URL'.padEnd(55) + 'Web Port'.padEnd(15) + 'API Port'.padEnd(15) + 'Path'));
    console.log(chalk.gray('─'.repeat(120)));

    if (!routes || !Array.isArray(routes) || routes.length === 0) {
      console.log(chalk.gray('No routes configured'));
      console.log(chalk.gray('─'.repeat(120)));
      return [];
    }

    const routeList: RouteInfo[] = [];

    for (const route of routes) {
      if (route.match?.[0]?.host?.[0]?.includes(baseDomain)) {
        const host = route.match[0].host[0];
        const fullUrl = `https://${host}`;

        let apiPort = 'N/A';
        let webPort = 'N/A';
        let workPath = 'N/A';

        // Check if this is a subroute (api+web) or standalone route
        if (route.handle[0]?.handler === 'subroute' && route.handle[0]?.routes) {
          // Subroute structure (api+web combined)
          const apiRoute = route.handle[0].routes.find((r: any) => r.match?.[0]?.path);
          const webRoute = route.handle[0].routes.find((r: any) => !r.match || !r.match[0].path);

          apiPort = apiRoute?.handle[0].upstreams[0].dial.split(':')[1] || 'N/A';
          webPort = webRoute?.handle[0].upstreams[0].dial.split(':')[1] || 'N/A';
          workPath = apiRoute?.handle[0].headers?.response?.set?.['X-Worktree-Path']?.[0] || 'N/A';
        } else if (route.handle[0]?.handler === 'reverse_proxy') {
          // Standalone route (single app)
          const appPort = route.handle[0].upstreams[0].dial.split(':')[1] || 'N/A';
          webPort = appPort; // Use as web port for display
          workPath = route.handle[0].headers?.response?.set?.['X-Worktree-Path']?.[0] || 'N/A';
        }

        console.log(
          chalk.cyan(fullUrl.padEnd(55)) +
          chalk.yellow(webPort.padEnd(15)) +
          chalk.yellow(apiPort.padEnd(15)) +
          chalk.gray(workPath)
        );

        routeList.push({
          url: fullUrl,
          host,
          apiPort,
          webPort,
          path: workPath,
          id: route['@id']
        });
      }
    }

    console.log(chalk.gray('─'.repeat(120)));

    return routeList;
  }

  /**
   * Get ports for a specific subdomain
   */
  async getPortsForSubdomain(subdomain: string): Promise<{ api: number; web: number; path: string } | null> {
    try {
      const routes = await this.getRoutes();
      if (routes) {
        const route = routes.find(r => r['@id'] === `route-${subdomain}`);
        if (route) {
          const apiRoute = route.handle[0].routes.find((r: any) => r.match?.[0]?.path);
          const webRoute = route.handle[0].routes.find((r: any) => !r.match);

          return {
            api: parseInt(apiRoute?.handle[0].upstreams[0].dial.split(':')[1]),
            web: parseInt(webRoute?.handle[0].upstreams[0].dial.split(':')[1]),
            path: apiRoute?.handle[0].headers?.response?.set?.['X-Worktree-Path']?.[0]
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
