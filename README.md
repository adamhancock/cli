# @adamhancock/cli

A monorepo containing CLI tools for development workflows.

## Packages

### [@adamhancock/worktree](./packages/worktree)
Git worktree manager with branch selection, dependency installation, and VS Code integration.

```bash
npm install -g @adamhancock/worktree
worktree
```

### [@adamhancock/tmuxdev](./packages/tmuxdev)
CLI tool to manage tmux sessions for development servers.

```bash
npm install -g @adamhancock/tmuxdev
tmuxdev
```

### [@adamhancock/transcribe](./packages/transcribe)
CLI tool for transcribing and summarizing MP4 recordings using Whisper and Ollama.

```bash
npm install -g @adamhancock/transcribe
transcribe
```

## Development

This monorepo uses [pnpm](https://pnpm.io/) for package management.

### Setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests across all packages
pnpm test
```

### Creating a New Package

Use the provided script to scaffold a new package:

```bash
./scripts/create-package.sh <package-name>
```

This will create a new package with:
- TypeScript configuration
- Build setup
- Package.json with proper naming convention
- Basic file structure

### Publishing

Packages are automatically published to npm when changes are pushed to the `main` branch. The GitHub Action will:

1. Check for version changes
2. Publish updated packages to npm
3. Create git tags for each published version

You can also manually trigger publishing through GitHub Actions.

### Manual Publishing

```bash
# Publish all packages with version changes
pnpm publish-packages

# Publish a specific package
cd packages/<package-name>
pnpm publish --access public
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Each package maintains its own license. See the individual package directories for details.

## Author

Adam Hancock