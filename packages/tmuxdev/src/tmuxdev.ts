#!/usr/bin/env node

import { $, chalk, argv, echo } from 'zx'
import inquirer from 'inquirer'

$.verbose = false

async function getFolderName(): Promise<string> {
  const pwd = await $`pwd`
  const path = pwd.stdout.trim()
  return path.split('/').pop() || 'tmuxdev'
}

async function getBranchName(): Promise<string> {
  try {
    const branch = await $`git branch --show-current`
    return branch.stdout.trim()
  } catch {
    // Not a git repo or no git installed
    return ''
  }
}

async function getSessionName(): Promise<string> {
  const folderName = await getFolderName()
  const branchName = await getBranchName()
  
  if (branchName) {
    return `${folderName}-${branchName}`
  }
  return folderName
}

async function sessionExists(sessionName: string): Promise<boolean> {
  try {
    await $`tmux has-session -t ${sessionName}`
    return true
  } catch {
    return false
  }
}

async function getAllSessions(): Promise<string[]> {
  try {
    const sessions = await $`tmux list-sessions -F "#{session_name}"`
    return sessions.stdout.trim().split('\n').filter(s => s)
  } catch {
    return []
  }
}

async function createSession(sessionName: string): Promise<void> {
  echo(chalk.green(`Creating new tmux session '${sessionName}'...`))
  await $`tmux new-session -d -s ${sessionName}`
  echo(chalk.blue(`Sending 'npm run dev' command to session '${sessionName}'...`))
  await $`tmux send-keys -t ${sessionName} 'npm run dev' Enter`
  echo(chalk.blue(`Development server starting in tmux session '${sessionName}'`))
}

async function attachSession(sessionName: string): Promise<void> {
  echo(chalk.green(`Attaching to tmux session '${sessionName}'...`))
  // Use zx with stdio option to properly attach to tmux
  try {
    await $({ stdio: 'inherit' })`tmux attach-session -t ${sessionName}`
  } catch (error) {
    // tmux attach exits with code 0 on detach, so we can ignore errors
  }
}

async function killSession(sessionName: string): Promise<void> {
  await $`tmux kill-session -t ${sessionName}`
  echo(chalk.red(`Killed session '${sessionName}'`))
}

type ActionChoice = 'attach-current' | 'create-current' | 'select-existing' | 'kill-session' | 'exit'

interface Choice {
  name: string
  value: ActionChoice
}

async function main(): Promise<void> {
  const sessionName = await getSessionName()
  const exists = await sessionExists(sessionName)
  
  // Handle command line arguments
  const command = argv._[0]
  
  // If no command provided, default to start behavior
  if (!command) {
    if (exists) {
      echo(chalk.yellow(`Session '${sessionName}' already exists. Attaching...`))
      await attachSession(sessionName)
    } else {
      await createSession(sessionName)
      await attachSession(sessionName)
    }
    return
  }
  
  if (command === 'start' || command === 's') {
    if (exists) {
      echo(chalk.yellow(`Session '${sessionName}' already exists. Attaching...`))
      await attachSession(sessionName)
    } else {
      await createSession(sessionName)
      await attachSession(sessionName)
    }
    return
  }
  
  if (command === 'attach' || command === 'a') {
    if (exists) {
      await attachSession(sessionName)
    } else {
      echo(chalk.red(`Session '${sessionName}' does not exist.`))
      let create: boolean
      try {
        const answer = await inquirer.prompt<{ create: boolean }>([
          {
            type: 'confirm',
            name: 'create',
            message: 'Would you like to start it?',
            default: true
          }
        ])
        create = answer.create
      } catch (error) {
        echo(chalk.yellow('\nExiting...'))
        process.exit(0)
      }
      if (create) {
        await createSession(sessionName)
        await attachSession(sessionName)
      }
    }
    return
  }
  
  if (command === 'menu' || command === 'm') {
    // Continue to interactive menu
  } else if (command === 'help' || command === 'h' || argv.help || argv.h) {
    echo(chalk.blue.bold('\n🖥️  tmuxdev - Tmux session manager for development'))
    echo(chalk.gray('  Automatically manages tmux sessions using folder and branch names'))
    
    echo(chalk.yellow('\n📋 Usage:'))
    echo('  tmuxdev              ' + chalk.gray('Start/attach to session for current directory'))
    echo('  tmuxdev menu|m       ' + chalk.gray('Interactive menu for session management'))
    echo('  tmuxdev start|s      ' + chalk.gray('Start and attach to session for current directory'))
    echo('  tmuxdev attach|a     ' + chalk.gray('Attach to existing session for current directory'))
    echo('  tmuxdev help|h       ' + chalk.gray('Show this help message'))
    
    echo(chalk.yellow('\n⚡ Quick Examples:'))
    echo(chalk.gray('  # Quick start for current directory'))
    echo('  $ tmuxdev')
    echo(chalk.gray('  # Interactive menu'))
    echo('  $ tmuxdev m')
    echo(chalk.gray('  # Attach to existing session'))
    echo('  $ tmuxdev a')
    
    echo(chalk.yellow('\n🎮 Tmux Controls:'))
    echo('  Ctrl+B then D        ' + chalk.gray('Detach from session'))
    echo('  Ctrl+B then [        ' + chalk.gray('Enter scroll/copy mode'))
    echo('  Ctrl+B then %        ' + chalk.gray('Split pane vertically'))
    echo('  Ctrl+B then "        ' + chalk.gray('Split pane horizontally'))
    
    echo(chalk.yellow('\n📦 Session Info:'))
    echo('  Current directory: ' + chalk.cyan(await getFolderName()))
    echo('  Session name:      ' + chalk.cyan(sessionName))
    echo('  Session exists:    ' + (exists ? chalk.green('Yes') : chalk.red('No')))
    
    return
  } else if (command) {
    // Unknown command
    echo(chalk.red(`Unknown command: ${command}`))
    echo(chalk.gray('Run "tmuxdev help" for usage information'))
    process.exit(1)
  }
  
  // Interactive menu mode (only reached with 'menu' or 'm' command)
  const allSessions = await getAllSessions()
  const choices: Choice[] = []
  
  if (exists) {
    choices.push({ name: `Attach to current branch session (${sessionName})`, value: 'attach-current' })
  } else {
    choices.push({ name: `Start new session for current directory (${sessionName})`, value: 'create-current' })
  }
  
  if (allSessions.length > 0) {
    choices.push({ name: 'Select from existing sessions', value: 'select-existing' })
    choices.push({ name: 'Kill a session', value: 'kill-session' })
  }
  
  choices.push({ name: 'Exit', value: 'exit' })
  
  let action: ActionChoice
  try {
    const answer = await inquirer.prompt<{ action: ActionChoice }>([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices
      }
    ])
    action = answer.action
  } catch (error) {
    echo(chalk.yellow('\nExiting...'))
    process.exit(0)
  }
  
  switch (action) {
    case 'attach-current':
      await attachSession(sessionName)
      break
      
    case 'create-current':
      await createSession(sessionName)
      let attachNow: boolean
      try {
        const answer = await inquirer.prompt<{ attachNow: boolean }>([
          {
            type: 'confirm',
            name: 'attachNow',
            message: 'Would you like to attach to the session now?',
            default: true
          }
        ])
        attachNow = answer.attachNow
      } catch (error) {
        echo(chalk.yellow('\nExiting...'))
        process.exit(0)
      }
      if (attachNow) {
        await attachSession(sessionName)
      } else {
        echo(chalk.yellow(`To attach later, run: tmux attach-session -t '${sessionName}'`))
        echo(chalk.yellow(`To detach from the session, press: Ctrl+B then D`))
      }
      break
      
    case 'select-existing':
      let selectedSession: string
      try {
        const answer = await inquirer.prompt<{ selectedSession: string }>([
          {
            type: 'list',
            name: 'selectedSession',
            message: 'Select a session to attach to:',
            choices: allSessions.map(s => ({ name: s, value: s }))
          }
        ])
        selectedSession = answer.selectedSession
      } catch (error) {
        echo(chalk.yellow('\nExiting...'))
        process.exit(0)
      }
      await attachSession(selectedSession)
      break
      
    case 'kill-session':
      let sessionToKill: string
      try {
        const answer = await inquirer.prompt<{ sessionToKill: string }>([
          {
            type: 'list',
            name: 'sessionToKill',
            message: 'Select a session to kill:',
            choices: allSessions.map(s => ({ name: s, value: s }))
          }
        ])
        sessionToKill = answer.sessionToKill
      } catch (error) {
        echo(chalk.yellow('\nExiting...'))
        process.exit(0)
      }
      
      let confirmKill: boolean
      try {
        const answer = await inquirer.prompt<{ confirmKill: boolean }>([
          {
            type: 'confirm',
            name: 'confirmKill',
            message: `Are you sure you want to kill session '${sessionToKill}'?`,
            default: false
          }
        ])
        confirmKill = answer.confirmKill
      } catch (error) {
        echo(chalk.yellow('\nExiting...'))
        process.exit(0)
      }
      
      if (confirmKill) {
        await killSession(sessionToKill)
      }
      break
      
    case 'exit':
      echo(chalk.blue('Goodbye!'))
      break
  }
}

main().catch(console.error)