/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Default Repository Path - Default path to your repository (e.g., ~/Code/myrepo) */
  "defaultRepoPath"?: string,
  /** Code Folder - Default folder containing your git repositories (e.g., ~/Code) */
  "codeFolder": string,
  /** Dev Environment Domain - Domain suffix for development environments (e.g., myproject.localhost) */
  "devDomain": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `index` command */
  export type Index = ExtensionPreferences & {}
  /** Preferences accessible in the `create-worktree` command */
  export type CreateWorktree = ExtensionPreferences & {}
  /** Preferences accessible in the `cleanup-environments` command */
  export type CleanupEnvironments = ExtensionPreferences & {}
  /** Preferences accessible in the `open-dev-environment` command */
  export type OpenDevEnvironment = ExtensionPreferences & {}
  /** Preferences accessible in the `chrome-tabs` command */
  export type ChromeTabs = ExtensionPreferences & {}
  /** Preferences accessible in the `open-active-dev-instance` command */
  export type OpenActiveDevInstance = ExtensionPreferences & {}
  /** Preferences accessible in the `open-spotlight-environment` command */
  export type OpenSpotlightEnvironment = ExtensionPreferences & {}
  /** Preferences accessible in the `open-pr-in-chrome` command */
  export type OpenPrInChrome = ExtensionPreferences & {}
  /** Preferences accessible in the `cleanup-stale-worktrees` command */
  export type CleanupStaleWorktrees = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `index` command */
  export type Index = {}
  /** Arguments passed to the `create-worktree` command */
  export type CreateWorktree = {}
  /** Arguments passed to the `cleanup-environments` command */
  export type CleanupEnvironments = {}
  /** Arguments passed to the `open-dev-environment` command */
  export type OpenDevEnvironment = {}
  /** Arguments passed to the `chrome-tabs` command */
  export type ChromeTabs = {}
  /** Arguments passed to the `open-active-dev-instance` command */
  export type OpenActiveDevInstance = {}
  /** Arguments passed to the `open-spotlight-environment` command */
  export type OpenSpotlightEnvironment = {}
  /** Arguments passed to the `open-pr-in-chrome` command */
  export type OpenPrInChrome = {}
  /** Arguments passed to the `cleanup-stale-worktrees` command */
  export type CleanupStaleWorktrees = {}
}

