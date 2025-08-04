# PortX - TypeScript Edition

A modern TypeScript port testing CLI tool for checking network connectivity and HTTP status.

## Installation

```bash
npm install -g @adamhancock/portx
```

## Usage

### Test a single host
```bash
portx -h google.com:443
```

### Test with HTTP status check
```bash
portx -h google.com:443 -s
portx -h google.com:443 -s https
```

### Test from a file
```bash
portx -f hosts.json
```

### Test with environment templating
```bash
portx -f template-hosts.json -e dev,staging,prod
```

## Configuration Files

### Simple hosts file (`hosts.json`)
```json
[
  {
    "name": "Google",
    "host": "google.com",
    "port": 443
  },
  {
    "name": "GitHub", 
    "host": "github.com",
    "port": 443
  }
]
```

### Template hosts file with environment variables
```json
[
  {
    "name": "API Server",
    "host": "{{env}}.api.example.com",
    "port": 443
  }
]
```

## Options

- `-h, --host <string>`: Test a single host in format `host:port`
- `-f, --file <string>`: Load hosts from a JSON file
- `-e, --env <string>`: Environment templating (comma-separated environments)
- `-s, --status [type]`: Check HTTP status code (optional: specify 'http' or 'https')
- `-v, --version`: Show version number

## Features

- ✅ Port connectivity testing
- ✅ DNS resolution
- ✅ HTTP/HTTPS status checking
- ✅ Environment templating with Handlebars
- ✅ Colorized output
- ✅ TypeScript with full type safety
- ✅ Modern async/await patterns

## Examples

Check if services are accessible:
```bash
portx -h api.example.com:443 -s https
```

Test multiple environments:
```bash
portx -f hosts.json -e dev,staging,prod
```

## License

ISC