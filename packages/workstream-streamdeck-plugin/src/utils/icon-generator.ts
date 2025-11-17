import type { VSCodeInstance } from '../types';

/**
 * Color scheme for instance states
 */
const COLORS = {
  // Background colors
  noInstance: '#2C2C2E', // Dark gray
  clean: '#30D158', // Green - clean git state
  dirty: '#FF9F0A', // Orange - uncommitted changes
  conflicts: '#FF453A', // Red - merge conflicts
  claudeActive: '#0A84FF', // Blue - Claude is active
  claudeWorking: '#BF5AF2', // Purple - Claude is working

  // Badge/indicator colors
  badge: '#FFFFFF',
  badgeBorder: 'rgba(0, 0, 0, 0.3)',

  // Text colors
  text: '#FFFFFF',
  textSecondary: 'rgba(255, 255, 255, 0.7)',
} as const;

/**
 * Generate an SVG icon based on VSCode instance state
 * Returns a data URI suitable for Stream Deck
 */
export function generateInstanceIcon(
  instance: VSCodeInstance | null,
  displayText: string = ''
): string {
  const svg = instance ? generateInstanceSvg(instance, displayText) : generateEmptySvg();

  // Convert SVG to data URI for Stream Deck
  return svgToDataUri(svg);
}

/**
 * Escape XML special characters
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Split text on hyphens into lines
 * Only split on hyphens that appear after the 10th character
 */
function splitTextIntoLines(text: string, maxLines: number = 3): string[] {
  const lines: string[] = [];
  let remaining = text;

  while (remaining.length > 0 && lines.length < maxLines) {
    // If remaining text is short enough, add it and stop
    if (remaining.length <= 10) {
      lines.push(remaining);
      break;
    }

    // Find first hyphen after position 10
    const hyphenIndex = remaining.indexOf('-', 10);

    if (hyphenIndex === -1) {
      // No hyphen found after position 10, add whole remaining text
      lines.push(remaining);
      break;
    }

    // Split at the hyphen (don't include the hyphen)
    lines.push(remaining.substring(0, hyphenIndex));
    remaining = remaining.substring(hyphenIndex + 1); // Skip the hyphen
  }

  // If we hit max lines and there's still text, add it to the last line
  if (remaining.length > 0 && lines.length === maxLines) {
    lines[lines.length - 1] = lines[lines.length - 1] + '-' + remaining;
  }

  return lines;
}

/**
 * Calculate font size based on text length and number of lines
 */
function calculateFontSize(text: string, lineCount: number): number {
  const avgLineLength = text.length / lineCount;

  if (lineCount === 1) {
    if (text.length <= 5) return 24;
    if (text.length <= 8) return 20;
    if (text.length <= 12) return 16;
    if (text.length <= 18) return 14;
    return 12;
  } else if (lineCount === 2) {
    if (avgLineLength <= 8) return 18;
    if (avgLineLength <= 12) return 16;
    return 14;
  } else {
    // 3+ lines
    if (avgLineLength <= 8) return 16;
    if (avgLineLength <= 12) return 14;
    return 12;
  }
}

/**
 * Generate the SVG markup for an instance
 */
function generateInstanceSvg(instance: VSCodeInstance, displayText: string): string {
  // Determine background color based on state
  let bgColor: string = COLORS.clean;
  let showBadge = false;
  let badgeIcon = '';

  // Priority order: Claude working > conflicts > dirty > Claude active > clean
  if (instance.claudeStatus?.isWorking) {
    bgColor = COLORS.claudeWorking;
    showBadge = true;
    badgeIcon = '🤖';
  } else if (instance.prStatus?.hasConflicts) {
    bgColor = COLORS.conflicts;
    showBadge = true;
    badgeIcon = '⚠️';
  } else if (instance.gitInfo?.isDirty) {
    bgColor = COLORS.dirty;
    showBadge = true;
    badgeIcon = '●';
  } else if (instance.claudeStatus?.active) {
    bgColor = COLORS.claudeActive;
  }

  // Split text into lines on hyphens
  const lines = splitTextIntoLines(displayText);
  const fontSize = calculateFontSize(displayText, lines.length);
  const lineHeight = fontSize + 4;

  // Calculate starting Y position to center the text block
  const totalHeight = (lines.length - 1) * lineHeight;
  const startY = 72 + (72 - totalHeight) / 2;

  // Generate text elements - use separate text elements for each line for reliability
  const textElements = lines.map((line, index) => {
    const y = startY + (index * lineHeight);
    return `
      <text
        x="72"
        y="${y}"
        text-anchor="middle"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
        font-size="${fontSize}"
        font-weight="600"
        fill="${COLORS.text}"
        style="text-shadow: 0 1px 3px rgba(0,0,0,0.3);"
      >
        ${escapeXml(line)}
      </text>
    `;
  }).join('');

  return `
    <svg width="144" height="144" viewBox="0 0 144 144" xmlns="http://www.w3.org/2000/svg">
      <!-- Background -->
      <rect width="144" height="144" rx="20" fill="${bgColor}"/>

      ${showBadge ? generateBadge(badgeIcon) : ''}

      <!-- Display text (multi-line) -->
      ${displayText ? textElements : ''}
    </svg>
  `.trim();
}

/**
 * Generate empty/no instance SVG markup
 */
function generateEmptySvg(): string {
  return `
    <svg width="144" height="144" viewBox="0 0 144 144" xmlns="http://www.w3.org/2000/svg">
      <!-- Background -->
      <rect width="144" height="144" rx="20" fill="${COLORS.noInstance}"/>

      <!-- VS Code Icon (dimmed) -->
      <g transform="translate(32, 32)" opacity="0.3">
        ${generateVSCodeLogo()}
      </g>

      <!-- No Instance Indicator -->
      <text
        x="72"
        y="120"
        text-anchor="middle"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="14"
        fill="${COLORS.textSecondary}"
      >
        No Instance
      </text>
    </svg>
  `.trim();
}

/**
 * Convert SVG string to data URI for Stream Deck
 */
function svgToDataUri(svg: string): string {
  // Encode SVG as base64
  const base64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}

/**
 * Generate VS Code logo (simplified)
 */
function generateVSCodeLogo(): string {
  return `
    <path
      d="M60 2.5L22.5 10v60L60 77.5l-15-15V30l15-15L52.5 7.5 30 30v20l22.5 22.5L45 80 15 65V15L52.5 7.5z"
      fill="${COLORS.badge}"
      opacity="0.9"
    />
    <path
      d="M60 2.5v75L45 65V15L60 2.5z"
      fill="${COLORS.badge}"
    />
  `;
}

/**
 * Generate a badge in the top-right corner
 */
function generateBadge(icon: string): string {
  const size = 36;
  const x = 144 - size - 8;
  const y = 8;

  return `
    <!-- Badge background -->
    <circle
      cx="${x + size / 2}"
      cy="${y + size / 2}"
      r="${size / 2}"
      fill="${COLORS.badge}"
      stroke="${COLORS.badgeBorder}"
      stroke-width="2"
    />

    <!-- Badge icon/text -->
    <text
      x="${x + size / 2}"
      y="${y + size / 2 + 4}"
      text-anchor="middle"
      font-size="20"
    >
      ${icon}
    </text>
  `;
}

/**
 * Generate an icon with custom color (for testing/development)
 */
export function generateCustomIcon(color: string, label?: string): string {
  const svg = `
    <svg width="144" height="144" viewBox="0 0 144 144" xmlns="http://www.w3.org/2000/svg">
      <rect width="144" height="144" rx="20" fill="${color}"/>
      ${
        label
          ? `<text
              x="72"
              y="80"
              text-anchor="middle"
              font-family="system-ui, -apple-system, sans-serif"
              font-size="16"
              font-weight="600"
              fill="${COLORS.text}"
            >
              ${label}
            </text>`
          : ''
      }
    </svg>
  `.trim();

  return svgToDataUri(svg);
}
