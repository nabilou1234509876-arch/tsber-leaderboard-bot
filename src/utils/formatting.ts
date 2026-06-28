import { PlayerStatus } from '../types/index.js';

/**
 * Format rank for display: "Unranked" for null, "#N" for ranked.
 */
export function formatRank(rank: number | null | undefined): string {
  if (rank === null || rank === undefined) return 'Unranked';
  return `#${rank}`;
}

/**
 * Format a player's W/L record.
 */
export function formatRecord(wins: number, losses: number): string {
  return `${wins}W / ${losses}L`;
}

/**
 * Format a player's streak for display.
 */
export function formatStreak(streak: number): string {
  if (streak > 0) return `🔥 ${streak}W`;
  if (streak < 0) return `💀 ${Math.abs(streak)}L`;
  return '—';
}

/**
 * Format a player's status as text.
 */
export function getStatusText(status: PlayerStatus): string {
  switch (status) {
    case PlayerStatus.IDLE:
      return 'Challengeable';
    case PlayerStatus.CHALLENGING:
      return 'Challenging';
    case PlayerStatus.CHALLENGED:
      return 'Challenged';
    case PlayerStatus.IMMUNE:
      return 'Immune';
    case PlayerStatus.COOLDOWN:
      return 'Cooldown';
    default:
      return 'Challengeable';
  }
}

/**
 * Format a player's status as an emoji indicator.
 */
export function getStatusEmoji(status: PlayerStatus): string {
  switch (status) {
    case PlayerStatus.CHALLENGING:
      return '⚔️';
    case PlayerStatus.CHALLENGED:
      return '🛡️';
    case PlayerStatus.IMMUNE:
      return '🛡️';
    case PlayerStatus.COOLDOWN:
      return '⏳';
    default:
      return '';
  }
}

/**
 * Build a visual progress bar using Unicode block characters.
 * Filled blocks: ▰, Empty blocks: ▱
 * 
 * @param ratio - Value between 0 and 1
 * @param length - Total number of blocks (default 10)
 * @returns A string like "▰▰▰▰▱▱▱▱▱▱"
 */
export function buildProgressBar(ratio: number, length = 10): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * length);
  return '▰'.repeat(filled) + '▱'.repeat(length - filled);
}

/**
 * Calculate a player's "form" ratio for the progress bar.
 * Based on win rate and recent streak. Returns 0-1.
 */
export function getFormRatio(wins: number, losses: number, streak: number): number {
  const total = wins + losses;
  if (total === 0) return 0;
  const winRate = wins / total;
  // Boost slightly for win streaks, reduce for loss streaks
  const streakBonus = Math.max(-0.2, Math.min(0.2, streak * 0.05));
  return Math.max(0, Math.min(1, winRate + streakBonus));
}

/**
 * Build a Roblox profile hyperlink.
 * Clicking the username takes you to their Roblox profile.
 */
export function robloxProfileLink(robloxUsername: string, robloxId: number): string {
  return `[${robloxUsername}](https://www.roblox.com/users/${robloxId}/profile)`;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Format a Date as a relative time string (Discord timestamp).
 */
export function discordTimestamp(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

/**
 * Format a Date as a Discord timestamp with full date/time.
 */
export function discordTimestampFull(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:F>`;
}
