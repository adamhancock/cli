# Quick Installation Guide

## Prerequisites

- macOS
- [Raycast](https://www.raycast.com/) installed
- [VS Code](https://code.visualstudio.com/) installed
- Node.js and npm

## Step-by-Step Installation

### 1. Navigate to the package

```bash
cd packages/workstream-raycast-extension
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create the icon (REQUIRED)

You need to create `assets/window-icon.png` before running the extension.

**Option A: Use SF Symbols (Easiest)**

1. Open SF Symbols app (included with macOS)
2. Search for "window" or "square.grid.2x2"
3. File → Export Symbol
4. Choose PNG format, 512x512px
5. Save as `assets/window-icon.png`

**Option B: Download an icon**

Download a window or VS Code icon from:
- https://www.flaticon.com
- https://icons8.com

Resize to 512x512px and save as `assets/window-icon.png`

**Option C: Create placeholder with ImageMagick**

If you have ImageMagick installed:

```bash
convert -size 512x512 xc:transparent \
  -fill '#007AFF' \
  -draw "roundrectangle 100,100 412,412 30,30" \
  -fill '#FFFFFF' \
  -draw "roundrectangle 120,120 240,240 15,15" \
  -draw "roundrectangle 272,120 392,240 15,15" \
  -draw "roundrectangle 120,272 240,392 15,15" \
  -draw "roundrectangle 272,272 392,392 15,15" \
  assets/window-icon.png
```

### 4. Start development mode

```bash
npm run dev
```

This will:
- Build the extension
- Open Raycast
- Load the extension in development mode

### 5. Test the extension

1. Open Raycast (Cmd+Space)
2. Type "Switch VS Code Window" or "Workstream"
3. You should see your open VS Code instances

## Optional: GitHub PR Integration

For PR status to work:

```bash
# Install GitHub CLI
brew install gh

# Authenticate
gh auth login
```

## Troubleshooting

### "Icon file not found" error

Make sure `assets/window-icon.png` exists and is a valid PNG file.

### "No VS Code instances detected"

- Ensure VS Code is running with at least one folder open
- The folder must be opened as a workspace (not just individual files)

### Dependencies not installing

Try:
```bash
rm -rf node_modules package-lock.json
npm install
```

## Building for Production

Once you're ready to use the extension permanently:

```bash
npm run build
```

Then import the extension into Raycast:
- Open Raycast Settings
- Go to Extensions
- Click "+" and select "Add Script Command"
- Navigate to the built extension

## Next Steps

- Configure keyboard shortcuts in Raycast Settings
- Customize the extension code in `src/index.tsx`
- Add more features from the workstream CLI tool
