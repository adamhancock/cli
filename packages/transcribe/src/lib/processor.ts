import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import { $ } from 'zx';
import chalk from 'chalk';
import os from 'os';
import crypto from 'crypto';

// Configure zx to be quiet
$.verbose = false;
$.quiet = true;

// Temp directory management
let tempDirPath: string | null = null;

export async function getTempDir(): Promise<string> {
  if (!tempDirPath) {
    const baseTempDir = os.tmpdir();
    const sessionId = crypto.randomBytes(8).toString('hex');
    tempDirPath = path.join(baseTempDir, 'transcribe', sessionId);
    await fs.mkdir(tempDirPath, { recursive: true });
  }
  return tempDirPath;
}

export async function cleanupTempDir(): Promise<void> {
  if (tempDirPath) {
    try {
      await fs.rm(tempDirPath, { recursive: true, force: true });
      tempDirPath = null;
    } catch (error) {
      console.error(chalk.yellow(`Warning: Failed to cleanup temp directory: ${error}`));
    }
  }
}

export interface FrameInfo {
  path: string;
  timestamp: number; // in seconds
  frameNumber: number;
}

export interface TranscriptSegment {
  text: string;
  start: number; // in seconds
  end: number; // in seconds
}

export interface TimestampedTranscript {
  fullText: string;
  segments: TranscriptSegment[];
}

export async function extractAudio(inputPath: string): Promise<string> {
  const tempDir = await getTempDir();
  const inputBasename = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(tempDir, `${inputBasename}.wav`);
  
  try {
    // Use ffmpeg to extract audio as WAV with proper format for Whisper
    await $`ffmpeg -i ${inputPath} -acodec pcm_s16le -ar 16000 -ac 1 ${outputPath} -y -loglevel error`;
    return outputPath;
  } catch (error) {
    throw new Error(`Failed to extract audio: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function extractFrames(
  inputPath: string, 
  interval: number = 3,
  maxFrames: number = 30
): Promise<FrameInfo[]> {
  const tempDir = await getTempDir();
  const inputBasename = path.basename(inputPath, path.extname(inputPath));
  const frameDir = path.join(tempDir, `${inputBasename}_frames`);
  
  // Create frames directory
  await fs.mkdir(frameDir, { recursive: true });
  
  // Get video duration
  const durationResult = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${inputPath}`;
  const duration = parseFloat(durationResult.stdout.trim());
  
  // Calculate how many frames we should extract based on interval
  const totalPossibleFrames = Math.floor(duration / interval);
  const frameCount = Math.min(maxFrames, totalPossibleFrames);
  
  // Extract frames at the specified interval
  await $`ffmpeg -i ${inputPath} -vf "fps=1/${interval}" -frames:v ${frameCount} ${frameDir}/frame_%04d.jpg -y -loglevel error`;
  
  // Get list of extracted frames
  const files = await fs.readdir(frameDir);
  const frameInfos: FrameInfo[] = files
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .slice(0, maxFrames)
    .map((f, index) => ({
      path: path.join(frameDir, f),
      timestamp: index * interval,
      frameNumber: index + 1
    }));
  
  return frameInfos;
}

export async function extractFramesAtTimestamps(
  inputPath: string,
  keyMoments: KeyMoment[]
): Promise<FrameInfo[]> {
  const tempDir = await getTempDir();
  const inputBasename = path.basename(inputPath, path.extname(inputPath));
  const frameDir = path.join(tempDir, `${inputBasename}_frames`);
  
  // Create frames directory
  await fs.mkdir(frameDir, { recursive: true });
  
  // Get video duration
  const durationResult = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${inputPath}`;
  const videoDuration = parseFloat(durationResult.stdout.trim());
  
  // Filter out moments that exceed video duration
  const validMoments = keyMoments.filter(m => m.timestamp < videoDuration);
  
  if (validMoments.length < keyMoments.length) {
    console.log(chalk.yellow(`  Note: ${keyMoments.length - validMoments.length} timestamps exceed video duration (${formatTimestamp(videoDuration)}) and were skipped`));
  }
  
  console.log(chalk.gray(`Extracting ${validMoments.length} frames at key moments:`));
  
  const frameInfos: FrameInfo[] = [];
  
  // Extract each frame at the specified timestamp
  for (let i = 0; i < validMoments.length; i++) {
    const moment = validMoments[i];
    const frameNumber = i + 1;
    const framePath = path.join(frameDir, `frame_${frameNumber.toString().padStart(4, '0')}.jpg`);
    
    try {
      // Extract single frame at specific timestamp
      await $`ffmpeg -ss ${moment.timestamp} -i ${inputPath} -frames:v 1 ${framePath} -y -loglevel error`;
      
      frameInfos.push({
        path: framePath,
        timestamp: moment.timestamp,
        frameNumber: frameNumber
      });
      
      console.log(chalk.gray(`  ✓ Frame ${frameNumber} at ${formatTimestamp(moment.timestamp)} - ${moment.reason}`));
    } catch (error) {
      console.error(chalk.yellow(`  ✗ Failed to extract frame at ${formatTimestamp(moment.timestamp)}`));
    }
  }
  
  return frameInfos;
}

export async function encodeImageToBase64(imagePath: string): Promise<string> {
  const imageBuffer = await fs.readFile(imagePath);
  return imageBuffer.toString('base64');
}

export async function transcribeAudio(audioPath: string, model: string = 'base'): Promise<TimestampedTranscript> {
  // Check if whisper is installed
  const whisperInstalled = await checkWhisperInstalled();
  
  if (!whisperInstalled) {
    throw new Error('Whisper is not installed. Please install it with: pip install openai-whisper');
  }
  
  return new Promise(async (resolve, reject) => {
    const tempDir = await getTempDir();
    const whisperProcess = spawn('whisper', [
      audioPath,
      '--model', model,
      '--output_format', 'json',
      '--output_dir', tempDir,
      '--language', 'en',
      '--fp16', 'False'
    ]);
    
    let stderr = '';
    
    whisperProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    whisperProcess.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Whisper process exited with code ${code}: ${stderr}`));
        return;
      }
      
      // Read the generated transcript with timestamps
      const audioBasename = path.basename(audioPath, path.extname(audioPath));
      const jsonPath = path.join(tempDir, `${audioBasename}.json`);
      try {
        const jsonContent = await fs.readFile(jsonPath, 'utf-8');
        const whisperOutput = JSON.parse(jsonContent);
        
        // Extract segments with timestamps
        const segments: TranscriptSegment[] = whisperOutput.segments.map((seg: any) => ({
          text: seg.text.trim(),
          start: seg.start,
          end: seg.end
        }));
        
        // Create full text
        const fullText = segments.map(s => s.text).join(' ');
        
        // Clean up whisper output files
        await fs.unlink(jsonPath).catch(() => {});
        
        resolve({
          fullText,
          segments
        });
      } catch (error) {
        reject(new Error('Failed to read transcript file'));
      }
    });
    
    whisperProcess.on('error', reject);
  });
}

async function checkWhisperInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const checkProcess = spawn('which', ['whisper']);
    checkProcess.on('close', (code) => {
      resolve(code === 0);
    });
    checkProcess.on('error', () => {
      resolve(false);
    });
  });
}

export async function summarizeTranscript(
  transcript: string,
  host: string = 'http://localhost:11434',
  model: string = 'gemma3',
  frameSummaries?: string[]
): Promise<string> {
  return summarizeWithOllama(transcript, host, model, frameSummaries);
}

export async function summarizeFrame(
  frameInfo: FrameInfo,
  host: string = 'http://localhost:11434',
  model: string = 'llava',
  previousFrameContext?: string
): Promise<string> {
  try {
    const modelExists = await checkOllamaModel(host, model);
    if (!modelExists) {
      await pullOllamaModel(host, model);
    }
    
    // Get file size for logging
    const stats = await fs.stat(frameInfo.path);
    const fileSizeKB = Math.round(stats.size / 1024);
    const timestamp = formatTimestamp(frameInfo.timestamp);
    console.log(chalk.gray(`    Processing frame ${frameInfo.frameNumber} at ${timestamp} (${fileSizeKB}KB): ${path.basename(frameInfo.path)}`));
    
    const base64 = await encodeImageToBase64(frameInfo.path);
    
    let prompt = `Analyze this video frame at timestamp ${timestamp} (frame #${frameInfo.frameNumber}) and describe what you see. Focus on the main visual elements, any text visible, the scene or activity shown, and any notable details.`;
    
    if (previousFrameContext) {
      prompt += `\n\nFor context, the previous frame showed: ${previousFrameContext}\n\nDescribe how this frame relates to or differs from the previous one.`;
    }
    
    prompt += ` Keep your description concise but informative.`;
    
    const response = await axios.post(`${host}/api/chat`, {
      model: model,
      messages: [
        {
          role: 'user',
          content: prompt,
          images: [base64]
        }
      ],
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 300
      }
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    return `[${timestamp}] Frame ${frameInfo.frameNumber}: ${response.data.message.content}`;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 400) {
      console.log(chalk.yellow(`    Model '${model}' may not support image analysis for frame ${frameInfo.frameNumber}`));
      return `[${formatTimestamp(frameInfo.timestamp)}] Frame ${frameInfo.frameNumber}: [Image analysis not supported by model]`;
    }
    throw error;
  }
}

function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function getRelevantTranscriptForFrame(
  frameTimestamp: number,
  segments: TranscriptSegment[],
  contextSeconds: number = 5
): string {
  // Find segments that overlap with the frame timestamp (±contextSeconds)
  const startTime = frameTimestamp - contextSeconds;
  const endTime = frameTimestamp + contextSeconds;
  
  const relevantSegments = segments.filter(segment => 
    (segment.start <= endTime && segment.end >= startTime)
  );
  
  if (relevantSegments.length === 0) {
    return '[No transcript available for this timestamp]';
  }
  
  return relevantSegments.map(s => s.text).join(' ');
}

export interface KeyMoment {
  timestamp: number;
  reason: string;
}

export interface VTTCue {
  start: number;
  end: number;
  text: string;
}

export async function identifyKeyMoments(
  segments: TranscriptSegment[],
  maxFrames: number = 30,
  host: string = 'http://localhost:11434',
  model: string = 'gemma3',
  videoDuration?: number
): Promise<KeyMoment[]> {
  try {
    // Check if model exists
    const modelExists = await checkOllamaModel(host, model);
    if (!modelExists) {
      await pullOllamaModel(host, model);
    }
    
    // Create a condensed transcript with timestamps
    const transcriptWithTimestamps = segments.map(s => 
      `[${formatTimestamp(s.start)}] ${s.text}`
    ).join('\n');
    
    // Get all actual timestamps from the transcript
    const actualTimestamps = segments.map(s => s.start);
    const lastTimestamp = segments[segments.length - 1]?.end || 0;
    
    // Simplify timestamps for easier selection
    const timestampPairs = actualTimestamps.slice(0, Math.min(100, actualTimestamps.length))
      .map(t => `${t}`)
      .join(',');
    
    const prompt = `You are analyzing a video transcript. Select exactly ${Math.min(maxFrames, 10)} important timestamps.

Available timestamps (choose ONLY from these):
${timestampPairs}

Find moments where:
- The speaker introduces a new topic
- Shows or demonstrates something
- Makes an important point
- Asks or answers questions
- Concludes or summarizes

Format each selection as: timestamp:brief reason
Separate with pipe character |

Example: 0:Introduction|15.5:Shows interface|45.2:Key concept explained|89.0:Final thoughts

Transcript excerpt:
${transcriptWithTimestamps.substring(0, 1500)}

Your selections:`;
    
    const response = await axios.post(`${host}/api/generate`, {
      model: model,
      prompt: prompt,
      stream: false,
      options: {
        temperature: 0.1,  // Lower temperature for more precise selection
        num_predict: 300
      }
    });
    
    // Parse the response to extract key moments
    let keyMoments: KeyMoment[] = [];
    const responseText = response.data.response.trim();
    
    // Debug log
    if (responseText.length < 200) {
      console.log(chalk.gray(`AI response: ${responseText}`));
    }
    
    try {
      // First try to parse as JSON in case the model returns that
      if (responseText.startsWith('[')) {
        const parsed = JSON.parse(responseText);
        if (Array.isArray(parsed)) {
          keyMoments = parsed
            .filter((item: any) => item.timestamp !== undefined)
            .map((item: any) => ({
              timestamp: parseFloat(item.timestamp),
              reason: String(item.reason || 'Key moment').substring(0, 100)
            }));
        }
      } else {
        // Parse simple format: timestamp:reason|timestamp:reason
        const pairs = responseText.split(/[|\n]/).filter((p: string) => p.includes(':'));
        
        keyMoments = pairs
          .map((pair: string) => {
            const colonIndex = pair.indexOf(':');
            if (colonIndex === -1) return null;
            
            const timestampStr = pair.substring(0, colonIndex).trim();
            const reason = pair.substring(colonIndex + 1).trim();
            const timestamp = parseFloat(timestampStr);
            
            if (!isNaN(timestamp) && reason) {
              return { timestamp, reason: reason.substring(0, 100) };
            }
            return null;
          })
          .filter((item: any): item is KeyMoment => item !== null);
      }
        
      if (keyMoments.length === 0) {
        console.log(chalk.yellow('No valid selections found in AI response'));
      } else {
        console.log(chalk.gray(`AI identified ${keyMoments.length} potential key moments`));
      }
    } catch (e) {
      console.log(chalk.yellow('Failed to parse AI response, using fallback approach'));
    }
    
    // Validate timestamps and ensure they exist in transcript
    const validKeyMoments: KeyMoment[] = [];
    const actualTimestampSet = new Set(actualTimestamps);
    
    for (const moment of keyMoments) {
      // Find the closest actual timestamp within 1 second
      const closest = actualTimestamps.find(t => Math.abs(t - moment.timestamp) < 1);
      if (closest !== undefined && !validKeyMoments.find(m => m.timestamp === closest)) {
        validKeyMoments.push({ timestamp: closest, reason: moment.reason });
      } else if (actualTimestampSet.has(moment.timestamp) && !validKeyMoments.find(m => m.timestamp === moment.timestamp)) {
        validKeyMoments.push(moment);
      }
    }
    
    // If we didn't get enough valid moments, use a smarter distribution
    if (validKeyMoments.length < Math.min(3, actualTimestamps.length)) {
      console.log(chalk.yellow('Using intelligent distribution for frame selection'));
      
      validKeyMoments.length = 0;
      
      // Always include first
      const firstSegment = segments[0];
      if (firstSegment) {
        validKeyMoments.push({
          timestamp: firstSegment.start,
          reason: `Opening: ${firstSegment.text.substring(0, 50)}...`
        });
      }
      
      // Find segments with key phrases
      const keyPhrases = [
        'today', 'going to', 'let\'s', 'look at', 'see', 'show', 'example',
        'important', 'key', 'main', 'first', 'second', 'finally', 'summary',
        'conclusion', 'question', 'how', 'what', 'why', 'when', 'where'
      ];
      
      const importantSegments = segments.filter(segment => {
        const lowerText = segment.text.toLowerCase();
        return keyPhrases.some(phrase => lowerText.includes(phrase));
      });
      
      // Add important segments up to maxFrames
      const step = Math.max(1, Math.floor(importantSegments.length / (maxFrames - 2)));
      for (let i = 0; i < importantSegments.length && validKeyMoments.length < maxFrames - 1; i += step) {
        const segment = importantSegments[i];
        if (!validKeyMoments.find(m => m.timestamp === segment.start)) {
          const preview = segment.text.substring(0, 60).replace(/\s+/g, ' ').trim();
          validKeyMoments.push({
            timestamp: segment.start,
            reason: preview + (segment.text.length > 60 ? '...' : '')
          });
        }
      }
      
      // If still not enough, distribute evenly
      if (validKeyMoments.length < Math.min(10, maxFrames)) {
        const targetCount = Math.min(maxFrames - validKeyMoments.length, segments.length);
        const step = Math.max(1, Math.floor(segments.length / targetCount));
        
        for (let i = step; i < segments.length && validKeyMoments.length < maxFrames - 1; i += step) {
          const segment = segments[i];
          if (!validKeyMoments.find(m => m.timestamp === segment.start)) {
            const preview = segment.text.substring(0, 60).replace(/\s+/g, ' ').trim();
            validKeyMoments.push({
              timestamp: segment.start,
              reason: preview + (segment.text.length > 60 ? '...' : '')
            });
          }
        }
      }
      
      // Always include last
      const lastSegment = segments[segments.length - 1];
      if (lastSegment && !validKeyMoments.find(m => m.timestamp === lastSegment.start)) {
        validKeyMoments.push({
          timestamp: lastSegment.start,
          reason: `Conclusion: ${lastSegment.text.substring(0, 50)}...`
        });
      }
    }
    
    return validKeyMoments
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, maxFrames);
  } catch (error) {
    console.error(chalk.yellow('Failed to identify key moments, falling back to fixed intervals'));
    throw error;
  }
}


async function checkOllamaModel(host: string, model: string): Promise<boolean> {
  try {
    const response = await axios.get(`${host}/api/tags`);
    const models = response.data.models || [];
    return models.some((m: any) => m.name === model || m.name === `${model}:latest`);
  } catch (error) {
    return false;
  }
}

async function pullOllamaModel(host: string, model: string): Promise<void> {
  console.log(chalk.yellow(`Model '${model}' not found. Pulling from Ollama registry...`));
  console.log(chalk.gray('This may take a few minutes depending on the model size.'));
  
  try {
    // Use streaming to show progress
    const response = await axios.post(`${host}/api/pull`, {
      name: model,
      stream: true
    }, {
      responseType: 'stream'
    });
    
    let lastStatus = '';
    response.data.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(line => line.trim());
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.status && data.status !== lastStatus) {
            lastStatus = data.status;
            process.stdout.write(`\r${chalk.gray(data.status)}`);
            if (data.completed && data.total) {
              const percent = Math.round((data.completed / data.total) * 100);
              process.stdout.write(` ${percent}%`);
            }
          }
        } catch (e) {
          // Ignore JSON parse errors
        }
      }
    });
    
    await new Promise((resolve, reject) => {
      response.data.on('end', resolve);
      response.data.on('error', reject);
    });
    
    console.log('\n' + chalk.green(`Successfully pulled model '${model}'`));
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`Failed to pull model '${model}': ${error.response?.data?.error || error.message}`);
    }
    throw error;
  }
}

export async function parseVTT(vttPath: string): Promise<TimestampedTranscript> {
  const vttContent = await fs.readFile(vttPath, 'utf-8');
  
  // Parse VTT format
  const cues: VTTCue[] = [];
  
  // Split by double newlines to get cue blocks
  const blocks = vttContent.split(/\n\s*\n/).filter(block => block.trim());
  
  for (const block of blocks) {
    // Skip WEBVTT header and other metadata
    if (block.startsWith('WEBVTT') || block.startsWith('NOTE')) {
      continue;
    }
    
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    
    // Parse timestamp line (e.g., "00:00:00.000 --> 00:00:05.000")
    const timestampLine = lines.find(line => line.includes('-->'));
    if (!timestampLine) continue;
    
    const timestampMatch = timestampLine.match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
    if (!timestampMatch) continue;
    
    const startTime = parseVTTTimestamp(timestampMatch[1]);
    const endTime = parseVTTTimestamp(timestampMatch[2]);
    
    // Get text (all lines after timestamp)
    const textStartIndex = lines.indexOf(timestampLine) + 1;
    const text = lines.slice(textStartIndex).join(' ').trim();
    
    if (text) {
      cues.push({ start: startTime, end: endTime, text });
    }
  }
  
  // Convert to TranscriptSegment format
  const segments: TranscriptSegment[] = cues.map(cue => ({
    text: cue.text,
    start: cue.start,
    end: cue.end
  }));
  
  // Create full text
  const fullText = segments.map(s => s.text).join(' ');
  
  return {
    fullText,
    segments
  };
}

function parseVTTTimestamp(timestamp: string): number {
  // Convert VTT timestamp (HH:MM:SS.mmm) to seconds
  const parts = timestamp.replace(',', '.').split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseFloat(parts[2]);
  
  return hours * 3600 + minutes * 60 + seconds;
}

// Map phase: Extract detailed information from each chunk
async function mapChunk(
  chunk: string,
  chunkNumber: number,
  totalChunks: number,
  host: string,
  model: string
): Promise<string> {
  const prompt = `You are performing the MAP phase of a map-reduce operation on meeting transcript chunk ${chunkNumber} of ${totalChunks}.

Your task is to extract and structure ALL information from this chunk. Be extremely thorough.

Format your response as follows:

TOPICS:
- [List each distinct topic discussed]

SPEAKERS & STATEMENTS:
- [Speaker name if mentioned]: [What they said/discussed]

DECISIONS:
- [List any decisions made with full context]

ACTION ITEMS:
- [What needs to be done] | [Who is responsible] | [Deadline if mentioned]

TOOLS/SYSTEMS MENTIONED:
- [Tool/System name]: [Context of how it was discussed]

TECHNICAL DETAILS:
- [List all technical specifications, configurations, or implementation details]

PROBLEMS/ISSUES:
- [Problem]: [Context and any proposed solutions]

METRICS/NUMBERS:
- [Any quantitative information, deadlines, timeframes]

KEY QUOTES:
- "[Important verbatim quotes that capture key points]"

CONTEXT CLUES:
- [Any information that helps understand the broader context]

Transcript chunk:
${chunk}

Extracted information:`;

  const response = await axios.post(`${host}/api/generate`, {
    model: model,
    prompt: prompt,
    stream: false,
    options: {
      temperature: 0.1,
      num_predict: 3000
    }
  });

  return response.data.response;
}

// Reduce phase: Combine and synthesize all mapped information
async function reduceChunks(
  mappedChunks: string[],
  transcript: string,
  host: string,
  model: string,
  frameSummaries?: string[]
): Promise<string> {
  const prompt = `You are performing the REDUCE phase of a map-reduce operation to create a comprehensive meeting summary.

You have been provided with detailed extractions from ${mappedChunks.length} chunks of a meeting transcript. Your task is to synthesize ALL this information into a single, extremely detailed summary that captures EVERYTHING important.

${frameSummaries && frameSummaries.length > 0 ? `
Additionally, here are visual frame analyses from the video:
${frameSummaries.join('\n\n')}
` : ''}

Here are the extracted details from each chunk:
${mappedChunks.join('\n\n---\n\n')}

Based on ALL the above information, create a COMPREHENSIVE summary with these sections:

# DETAILED MEETING SUMMARY

## 1. MEETING OVERVIEW
- Purpose and context
- Participants (all people mentioned)
- Key themes

## 2. COMPLETE TOPIC BREAKDOWN
For each topic discussed (in chronological order):
- **Topic Name**
  - What was discussed
  - Who participated
  - Key points made
  - Decisions reached
  - Issues raised
  - Solutions proposed

## 3. ALL DECISIONS MADE
List every decision with:
- The decision
- Who made it
- Reasoning/context
- Impact/implications

## 4. COMPREHENSIVE ACTION ITEMS
For each action item:
- Task description
- Assigned to
- Deadline/timeline
- Dependencies
- Context/reason

## 5. TOOLS & SYSTEMS DISCUSSED
For each tool/platform mentioned:
- Name (e.g., Ninja, Halo, PSA, Notion, Connectwise)
- How it's being used
- Issues/concerns
- Integration points
- Recommendations made

## 6. TECHNICAL SPECIFICATIONS
- All technical details mentioned
- Configurations discussed
- Implementation specifics
- Security considerations

## 7. PROBLEMS & SOLUTIONS
- Each problem/issue raised
- Proposed solutions
- Decisions on how to proceed
- Unresolved issues

## 8. KEY INSIGHTS & QUOTES
- Important realizations
- Memorable quotes
- Critical observations

## 9. NEXT STEPS & FOLLOW-UPS
- Immediate next steps
- Future meetings planned
- Items requiring follow-up
- Open questions

Be EXHAUSTIVE. Include every meaningful detail. Someone reading this summary should understand everything that was discussed as if they attended the meeting.

COMPREHENSIVE SUMMARY:`;

  const response = await axios.post(`${host}/api/generate`, {
    model: model,
    prompt: prompt,
    stream: false,
    options: {
      temperature: 0.2,
      num_predict: 6000  // Very high limit for comprehensive summary
    }
  });

  return response.data.response;
}

async function summarizeWithOllama(
  transcript: string,
  host: string,
  model: string,
  frameSummaries?: string[]
): Promise<string> {
  try {
    // Check if model exists
    const modelExists = await checkOllamaModel(host, model);
    if (!modelExists) {
      await pullOllamaModel(host, model);
    }
    
    // Use map-reduce for better summarization
    const MAX_CHUNK_SIZE = 3000; // characters per chunk
    const chunks: string[] = [];
    
    // Split transcript into chunks at sentence boundaries
    const sentences = transcript.match(/[^.!?]+[.!?]+/g) || [transcript];
    let currentChunk = '';
    
    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > MAX_CHUNK_SIZE && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += sentence;
      }
    }
    
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    
    // If transcript is short enough, process as single chunk
    if (chunks.length === 1) {
      console.log(chalk.gray('Processing transcript...'));
      const mapped = await mapChunk(transcript, 1, 1, host, model);
      return await reduceChunks([mapped], transcript, host, model, frameSummaries);
    }
    
    console.log(chalk.gray(`Using map-reduce strategy with ${chunks.length} chunks...`));
    
    // Map phase: Extract information from each chunk
    const mappedChunks: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(chalk.gray(`  MAP: Processing chunk ${i + 1}/${chunks.length}...`));
      const mapped = await mapChunk(chunks[i], i + 1, chunks.length, host, model);
      mappedChunks.push(mapped);
    }
    
    // Reduce phase: Combine all mapped information
    console.log(chalk.gray('  REDUCE: Synthesizing final summary...'));
    return await reduceChunks(mappedChunks, transcript, host, model, frameSummaries);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error('Cannot connect to Ollama. Make sure it is running on ' + host);
      }
      
      throw new Error(`Ollama API error: ${error.response?.data?.error || error.message}`);
    }
    throw error;
  }
}

