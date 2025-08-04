#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { extractAudio, extractFrames, extractFramesAtTimestamps, transcribeAudio, summarizeTranscript, summarizeFrame, getRelevantTranscriptForFrame, identifyKeyMoments, parseVTT, cleanupTempDir } from './lib/processor.js';
import type { FrameInfo, TimestampedTranscript, KeyMoment } from './lib/processor.js';
import fs from 'fs/promises';
import path from 'path';
import { $ } from 'zx';

// Configure zx to be quiet
$.verbose = false;
$.quiet = true;

function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

const program = new Command();

program
  .name('transcribe')
  .description('Transcribe and summarize MP4 recordings or VTT subtitles using local models')
  .version('1.0.0')
  .argument('<files...>', 'Path to MP4 and/or VTT file(s)')
  .option('-o, --output <path>', 'Output file path (default: input_transcript.txt)')
  .option('-a, --audio-only', 'Only extract audio without transcription')
  .option('-t, --transcribe-only', 'Only transcribe without summarization')
  .option('--host <host>', 'Ollama API host', 'http://localhost:11434')
  .option('--model <model>', 'Ollama model name for summarization', 'llama3.2')
  .option('--whisper-model <model>', 'Whisper model size', 'base')
  .option('--keep-audio', 'Keep extracted audio file after processing')
  .option('--no-analyze-frames', 'Disable frame extraction and analysis')
  .option('--frame-interval <seconds>', 'Seconds between frame extraction', '3')
  .option('--max-frames <count>', 'Maximum number of frames to extract', '30')
  .option('--keep-frames', 'Keep extracted frames after processing')
  .option('--save-timestamps', 'Save timestamped transcript segments to separate file')
  .option('--plain-transcript', 'Save transcript without timestamps in output file')
  .action(async (files, options) => {
    const spinner = ora('Processing...').start();
    
    try {
      // Separate files by type
      let vttFile: string | undefined;
      let mp4File: string | undefined;
      
      for (const file of files) {
        await fs.access(file);
        
        if (file.toLowerCase().endsWith('.vtt')) {
          if (vttFile) {
            throw new Error('Multiple VTT files provided. Please provide only one VTT file.');
          }
          vttFile = file;
        } else if (file.toLowerCase().endsWith('.mp4')) {
          if (mp4File) {
            throw new Error('Multiple MP4 files provided. Please provide only one MP4 file.');
          }
          mp4File = file;
        } else {
          throw new Error(`Unsupported file type: ${file}. Must be .mp4 or .vtt`);
        }
      }
      
      if (!vttFile && !mp4File) {
        throw new Error('No valid input files provided. Please provide at least one .mp4 or .vtt file.');
      }
      
      let timestampedTranscript: TimestampedTranscript;
      let audioPath: string | undefined;
      let videoPath: string | undefined;
      let primaryInput: string;
      
      if (vttFile) {
        // VTT file provided - use it for transcript
        primaryInput = vttFile;
        spinner.text = 'Parsing VTT file...';
        timestampedTranscript = await parseVTT(vttFile);
        spinner.succeed('VTT parsing completed');
        
        // Check if MP4 was also provided for frame analysis
        if (mp4File) {
          videoPath = mp4File;
          console.log(chalk.cyan('Video file provided for frame analysis'));
        }
      } else if (mp4File) {
        // Only MP4 provided - extract audio and transcribe
        primaryInput = mp4File;
        videoPath = mp4File;
        
        // Start audio extraction
        spinner.text = 'Extracting audio from MP4...';
        audioPath = await extractAudio(mp4File);
        spinner.succeed('Audio extraction completed');
        
        if (options.audioOnly) {
          console.log(chalk.green(`Audio saved to: ${audioPath}`));
          return;
        }
        
        // Transcribe audio
        spinner.start('Transcribing audio...');
        timestampedTranscript = await transcribeAudio(audioPath, options.whisperModel);
        spinner.succeed('Audio transcription completed');
      } else {
        throw new Error('No valid input files provided.');
      }
      
      // Extract and analyze frames if not disabled
      let frameSummaries: string[] = [];
      let frameInfos: FrameInfo[] = [];
      
      if (options.analyzeFrames !== false && !options.transcribeOnly && videoPath) {
        // Get video duration first
        const durationResult = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${videoPath}`;
        const videoDuration = parseFloat(durationResult.stdout.trim());
        
        // Identify key moments from transcript
        spinner.start('Analyzing transcript to identify key moments...');
        try {
          const keyMoments = await identifyKeyMoments(
            timestampedTranscript.segments,
            parseInt(options.maxFrames),
            options.host,
            'gemma3', // Use text model for analyzing transcript
            videoDuration
          );
          spinner.succeed(`Identified ${keyMoments.length} key moments for frame extraction`);
          
          // Extract frames at key moments
          frameInfos = await extractFramesAtTimestamps(videoPath, keyMoments);
          console.log(chalk.green(`✓ Extracted ${frameInfos.length} frames at key moments`));
        } catch (error) {
          // Fall back to fixed interval extraction
          console.error(chalk.yellow('Intelligent frame extraction failed, using fixed intervals'));
          spinner.start('Extracting frames at fixed intervals...');
          frameInfos = await extractFrames(
            videoPath,
            parseInt(options.frameInterval),
            parseInt(options.maxFrames)
          );
          spinner.succeed(`Extracted ${frameInfos.length} frames`);
        }
        
        // Analyze frames
        if (frameInfos.length > 0) {
          spinner.start(`Analyzing ${frameInfos.length} frames sequentially...`);
          
          let completedCount = 0;
          const totalFrames = frameInfos.length;
          
          // Process frames sequentially to maintain order and allow for context
          let previousFrameDescription: string | undefined;
          
          for (const frameInfo of frameInfos) {
            try {
              spinner.text = `Analyzing frame ${frameInfo.frameNumber}/${totalFrames}...`;
              
              const frameSummary = await summarizeFrame(frameInfo, options.host, options.model, previousFrameDescription);
              
              // Extract just the description part for context (without timestamp and frame number)
              const descriptionMatch = frameSummary.match(/Frame \d+: (.+)$/);
              if (descriptionMatch) {
                previousFrameDescription = descriptionMatch[1].trim();
              }
              
              // Add relevant transcript context to the frame summary
              const relevantTranscript = getRelevantTranscriptForFrame(
                frameInfo.timestamp,
                timestampedTranscript.segments
              );
              
              completedCount++;
              console.log(chalk.gray(`  ✓ Frame ${frameInfo.frameNumber} analyzed (${completedCount}/${totalFrames})`));
              
              frameSummaries.push(`${frameSummary}\n    Transcript context: "${relevantTranscript}"`);
            } catch (error) {
              completedCount++;
              console.error(chalk.yellow(`  ✗ Frame ${frameInfo.frameNumber} failed: ${error instanceof Error ? error.message : String(error)}`));
              frameSummaries.push(`[${frameInfo.timestamp}s] Frame ${frameInfo.frameNumber}: [Analysis failed]`);
              previousFrameDescription = undefined; // Reset context on failure
            }
          }
          
          spinner.succeed(`Analyzed ${frameSummaries.filter(s => !s.includes('[Analysis failed]')).length}/${totalFrames} frames`);
        }
      }
      
      // Format transcript based on user preference
      const transcriptText = options.plainTranscript 
        ? timestampedTranscript.fullText
        : timestampedTranscript.segments
            .map(segment => `[${formatTimestamp(segment.start)}] ${segment.text}`)
            .join('\n');
      
      let finalOutput = `Transcript of ${primaryInput}:\n\n${transcriptText}`;
      
      if (!options.transcribeOnly) {
        // Summarize with Ollama
        spinner.start('Generating final summary...');
        try {
          const summary = await summarizeTranscript(
            timestampedTranscript.fullText,
            options.host,
            options.model,
            frameSummaries
          );
          spinner.succeed('Summary generated successfully');
          console.log(chalk.cyan('\nSummary:'));
          console.log(chalk.white(summary));
          finalOutput += `\n\n---\n\nSummary:\n\n${summary}`;
        } catch (error) {
          spinner.warn('Failed to generate summary (is Ollama running?)');
          console.error(chalk.yellow(error instanceof Error ? error.message : String(error)));
        }
      }
      
      // Save output
      const outputPath = options.output || primaryInput.replace(/\.[^/.]+$/, '_transcript.txt');
      await fs.writeFile(outputPath, finalOutput, 'utf-8');
      console.log(chalk.green(`\nOutput saved to: ${outputPath}`));
      
      // Save timestamped segments if requested
      if (options.saveTimestamps) {
        const timestampPath = primaryInput.replace(/\.[^/.]+$/, '_timestamped.json');
        const timestampData = {
          primaryInput: primaryInput,
          videoInput: videoPath,
          transcript: timestampedTranscript,
          frameSummaries: frameSummaries.map((summary, index) => ({
            frameNumber: index + 1,
            timestamp: frameInfos[index]?.timestamp || index * parseInt(options.frameInterval),
            summary
          }))
        };
        await fs.writeFile(timestampPath, JSON.stringify(timestampData, null, 2), 'utf-8');
        console.log(chalk.green(`Timestamped data saved to: ${timestampPath}`));
      }
      
      // Copy audio file if keeping it
      if (options.keepAudio && audioPath) {
        const audioDestPath = primaryInput.replace(/\.[^/.]+$/, '.wav');
        await fs.copyFile(audioPath, audioDestPath);
        console.log(chalk.green(`Audio saved to: ${audioDestPath}`));
      }
      
      // Copy frames if keeping them
      if (frameInfos.length > 0 && options.keepFrames) {
        const framesDestDir = primaryInput.replace(/\.[^/.]+$/, '_frames');
        await fs.mkdir(framesDestDir, { recursive: true });
        
        for (const frameInfo of frameInfos) {
          const destPath = path.join(framesDestDir, path.basename(frameInfo.path));
          await fs.copyFile(frameInfo.path, destPath);
        }
        console.log(chalk.green(`Frames saved to: ${framesDestDir}`));
      }
      
      // Clean up temporary directory
      await cleanupTempDir();
      
    } catch (error) {
      spinner.fail('Error processing file');
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      
      // Ensure cleanup even on error
      await cleanupTempDir();
      
      process.exit(1);
    }
  });

program.parse();