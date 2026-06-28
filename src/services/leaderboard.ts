import { EmbedBuilder, TextChannel, type Client } from 'discord.js';
import { Player } from '../database/models/Player.js';
import { getGuildConfig } from '../database/models/GuildConfig.js';
import { PlayerStatus } from '../types/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import {
  getStatusText,
  buildProgressBar,
  getFormRatio,
  robloxProfileLink,
} from '../utils/formatting.js';
import { fetchRobloxHeadshot, isHeadshotExpired } from './rover.js';
import type { IPlayer } from '../database/models/Player.js';

let editTimer: NodeJS.Timeout | null = null;
const pendingGuilds = new Set<string>();

/**
 * Build a single player's card-like entry with progress bar + Roblox link.
 *
 * ┌──────────────────────────────────────┐
 * │ 🥇 #1  Username              ⚔️     │
 * │ ═══════════════════════════════════  │
 * │ ▰▰▰▰▰▰▰▱▱▱  70% form    5W / 2L     │
 * │ 🌍 EU  •  Status: Challengeable      │
 * └──────────────────────────────────────┘
 */
function playerSlot(player: any): string {
  const rank = player.rank ?? 0;
  const statusText = getStatusText(player.status as PlayerStatus);
  const statusEmoji = getStatusEmojiForSlot(player.status as PlayerStatus);
  const region = player.region ?? '-';
  const record = `${player.wins}W / ${player.losses}L`;
  const streak = getStreakText(player.streak);

  // Progress bar based on form (win rate + streak bonus)
  const formRatio = getFormRatio(player.wins, player.losses, player.streak);
  const bar = buildProgressBar(formRatio, 10);
  const formPct = Math.round(formRatio * 100);

  // Medal for top 3
  let medal = '';
  if (rank === 1) medal = '🥇';
  else if (rank === 2) medal = '🥈';
  else if (rank === 3) medal = '🥉';

  // Roblox username as clickable hyperlink
  const nameLink = robloxProfileLink(player.robloxUsername, player.robloxId);

  // Build the card
  return (
    `${medal} **#${rank}**  ${nameLink}  ${statusEmoji}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${bar}  \`${formPct}%\`  •  ${record}  •  ${streak}\n` +
    `🌍 ${region}  •  Status: **${statusText}**`
  );
}

/**
 * Build a vacant slot for empty ranks.
 */
function vacantSlot(rank: number): string {
  return (
    `**#${rank}**  Vacant\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `▱▱▱▱▱▱▱▱▱▱  \`0%\`  •  0W / 0L  •  —\n` +
    `🌍 —  •  Status: **Empty**`
  );
}

/**
 * Get status emoji for leaderboard display.
 */
function getStatusEmojiForSlot(status: PlayerStatus): string {
  switch (status) {
    case PlayerStatus.CHALLENGING:
      return '⚔️';
    case PlayerStatus.CHALLENGED:
      return '🎯';
    case PlayerStatus.IMMUNE:
      return '🛡️';
    case PlayerStatus.COOLDOWN:
      return '⏳';
    default:
      return '✅';
  }
}

/**
 * Get streak as short text.
 */
function getStreakText(streak: number): string {
  if (streak > 0) return `🔥${streak}`;
  if (streak < 0) return `💀${Math.abs(streak)}`;
  return '—';
}

/**
 * Build a leaderboard embed for a specific rank range.
 * Each rank gets its own card-style entry.
 * Empty ranks show as "Vacant".
 */
async function buildLeaderboardEmbed(
  guildId: string,
  minRank: number,
  maxRank: number,
  title: string,
): Promise<EmbedBuilder> {
  const players = await Player.find({ guildId, rank: { $gte: minRank, $lte: maxRank } })
    .sort({ rank: 1 })
    .lean();

  // Refresh expired headshots in the background
  for (const player of players) {
    if (player.robloxHeadshotUrl && isHeadshotExpired(player.robloxHeadshotExpiresAt)) {
      fetchRobloxHeadshot(player.robloxId).then(async ({ url, expiresAt }) => {
        if (url) {
          await Player.updateOne(
            { _id: player._id },
            { robloxHeadshotUrl: url, robloxHeadshotExpiresAt: expiresAt },
          );
        }
      });
    }
  }

  // Build a map of rank → player
  const playerMap = new Map<number, any>();
  for (const player of players) {
    if (player.rank !== null) {
      playerMap.set(player.rank, player);
    }
  }

  // Build the description with card-style entries
  const entries: string[] = [];

  for (let rank = minRank; rank <= maxRank; rank++) {
    const player = playerMap.get(rank);
    if (player) {
      entries.push(playerSlot(player));
    } else {
      entries.push(vacantSlot(rank));
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x1a1a2e)
    .setDescription(entries.join('\n\n'))
    .setTimestamp()
    .setFooter({ text: 'Click a username to view their Roblox profile • Updated in real-time' });

  // Set thumbnail to #1 player's headshot in this range
  const topPlayer = players.find((p) => p.rank === minRank);
  if (topPlayer?.robloxHeadshotUrl) {
    embed.setThumbnail(topPlayer.robloxHeadshotUrl);
  }

  return embed;
}

/**
 * Send or update the leaderboard messages across all configured channels.
 */
export async function initLeaderboardMessages(
  client: Client,
  guildId: string,
): Promise<void> {
  const guildConfig = await getGuildConfig(guildId);

  for (const lb of guildConfig.leaderboards) {
    try {
      const channel = await client.channels.fetch(lb.channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        logger.error(`Leaderboard channel ${lb.channelId} not found or not a text channel`);
        continue;
      }

      const embed = await buildLeaderboardEmbed(guildId, lb.minRank, lb.maxRank, lb.title);

      if (lb.messageId) {
        try {
          const message = await channel.messages.fetch(lb.messageId);
          await message.edit({ embeds: [embed] });
          logger.info(`Leaderboard "${lb.title}" message updated`);
          continue;
        } catch {
          logger.warn(`Existing leaderboard message for "${lb.title}" not found, creating new one`);
        }
      }

      const message = await channel.send({ embeds: [embed] });
      lb.messageId = message.id;
      logger.info(`Leaderboard "${lb.title}" message created (ID: ${message.id})`);
    } catch (error) {
      logger.error(`Failed to init leaderboard "${lb.title}":`, error);
    }
  }

  await guildConfig.save();
}

/**
 * Refresh all leaderboards for a guild by editing existing messages.
 * Debounced to avoid rate limits.
 */
export async function refreshLeaderboard(guildId: string): Promise<void> {
  pendingGuilds.add(guildId);

  if (editTimer) return;

  editTimer = setTimeout(async () => {
    editTimer = null;
    const guilds = Array.from(pendingGuilds);
    pendingGuilds.clear();

    for (const gid of guilds) {
      try {
        await refreshLeaderboardNow(gid);
      } catch (error) {
        logger.error(`Failed to refresh leaderboard for guild ${gid}:`, error);
      }
    }
  }, config.leaderboard.editDebounceMs);
}

/**
 * Immediately refresh all leaderboard messages for a guild.
 */
async function refreshLeaderboardNow(guildId: string): Promise<void> {
  const client = (globalThis as any).client as Client | undefined;
  if (!client) {
    logger.warn('Client not available on globalThis, skipping leaderboard refresh');
    return;
  }

  const guildConfig = await getGuildConfig(guildId);

  for (const lb of guildConfig.leaderboards) {
    if (!lb.channelId || !lb.messageId) {
      continue;
    }

    try {
      const channel = await client.channels.fetch(lb.channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        logger.error(`Leaderboard channel ${lb.channelId} not found`);
        continue;
      }

      const message = await channel.messages.fetch(lb.messageId);
      const embed = await buildLeaderboardEmbed(guildId, lb.minRank, lb.maxRank, lb.title);
      await message.edit({ embeds: [embed] });
      logger.debug(`Leaderboard "${lb.title}" refreshed for guild ${guildId}`);
    } catch (error) {
      logger.error(`Failed to edit leaderboard "${lb.title}":`, error);
      if (error instanceof Error && error.message.includes('Unknown Message')) {
        lb.messageId = null;
        await guildConfig.save();
        await initLeaderboardMessages(client, guildId);
      }
    }
  }
}
