#!/bin/bash

# Create new package script
set -e

if [ -z "$1" ]; then
  echo "Usage: ./scripts/create-package.sh <package-name>"
  exit 1
fi

PACKAGE_NAME=$1
PACKAGE_DIR="packages/$PACKAGE_NAME"

# Check if package already exists
if [ -d "$PACKAGE_DIR" ]; then
  echo "Error: Package '$PACKAGE_NAME' already exists"
  exit 1
fi

# Create package directory
mkdir -p "$PACKAGE_DIR/src"

# Create package.json
cat > "$PACKAGE_DIR/package.json" << EOF
{
  "name": "@adamhancock/$PACKAGE_NAME",
  "version": "0.0.1",
  "description": "",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc",
    "test": "echo \"Error: no test specified\" && exit 1",
    "lint": "eslint src --ext .ts",
    "prepublishOnly": "pnpm build"
  },
  "keywords": [],
  "author": "Adam Hancock",
  "license": "ISC",
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  },
  "publishConfig": {
    "access": "public"
  }
}
EOF

# Create tsconfig.json
cat > "$PACKAGE_DIR/tsconfig.json" << EOF
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

# Create .gitignore
cat > "$PACKAGE_DIR/.gitignore" << EOF
node_modules/
dist/
*.log
.DS_Store
EOF

# Create README.md
cat > "$PACKAGE_DIR/README.md" << EOF
# @adamhancock/$PACKAGE_NAME

## Description

TODO: Add package description

## Installation

\`\`\`bash
npm install @adamhancock/$PACKAGE_NAME
\`\`\`

## Usage

\`\`\`typescript
import { } from '@adamhancock/$PACKAGE_NAME';
\`\`\`

## License

ISC
EOF

# Create index.ts
cat > "$PACKAGE_DIR/src/index.ts" << EOF
export const hello = () => {
  console.log('Hello from @adamhancock/$PACKAGE_NAME!');
};
EOF

echo "✅ Package '$PACKAGE_NAME' created successfully at $PACKAGE_DIR"
echo ""
echo "Next steps:"
echo "1. cd $PACKAGE_DIR"
echo "2. pnpm install"
echo "3. Start developing your package"