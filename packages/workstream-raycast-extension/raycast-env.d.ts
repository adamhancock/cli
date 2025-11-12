/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `index` command */
  export type Index = ExtensionPreferences & {}
  /** Preferences accessible in the `create-worktree` command */
  export type CreateWorktree = ExtensionPreferences & {}
  /** Preferences accessible in the `cleanup-environments` command */
  export type CleanupEnvironments = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `index` command */
  export type Index = {}
  /** Arguments passed to the `create-worktree` command */
  export type CreateWorktree = {}
  /** Arguments passed to the `cleanup-environments` command */
  export type CleanupEnvironments = {}
}

