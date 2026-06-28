import { EmbedBuilder, TextChannel, type Client } from 'discord.js';
import { Player } from '../database/models/Player.js';
import { getGuildConfig } from '../database/models/GuildConfig.js';
import { PlayerStatus } from '../types/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { formatRank, getStatusText } from '../utils/formatting.js';
import { fetchRobloxHeadshot, isHeadshotExpired } from './rover.js';
import type { LeaderboardEntry } from '../database/models/GuildConfig.js';
import type { IPlayer } from '../database/models/Player.js';

let editTimer: NodeJS.Timeout | null = null;
const pendingGuilds = new Set<string>();

/**
 * Build the "Vacant" slot text for an empty rank position.
 */
function vacantSlot(rank: number): string {
  return (
    `**#${rank} Vacant**\n` +
    `| Vacant |\n` +
    `<< | .Vacant. | >>\n` +
    `Region: -\n` +
    `Stage: -\n` +
    `Status: -\n` +
    `wins: 0 losses: 0`
  );
}

/**
 * Build a player's entry text matching the TSBER leaderboard style.
 *
 * #1 Tragic
 * ID: 509
 * | @T |
 * << | .unwhirled. | >>
 * Region: EU
 * Stage: OLS
 * Status: Challengeable
 * wins: 0 losses: 0
 */
function playerSlot(player: any): string {
  const rank = formatRank(player.rank);
  const statusText = getStatusText(player.status as PlayerStatus);
  const region = player.region ?? '-';
  const stage = player.stage || '-';
  const record = `wins: ${player.wins} losses: ${player.losses}`;

  // Use Discord mention for the user
  const mention = `<@${player.discordId}>`;

  // Title/quote line — use Roblox username stylized
  const titleText = `<< | .${player.robloxUsername}. | >>`;

  return (
    `**${rank} ${player.robloxUsername}**\n` +
    `ID: ${player.robloxId}\n` +
    `| ${mention} |\n` +
    `${titleText}\n` +
    `Region: ${region}\n` +
    `Stage: **${stage}**\n` +
    `Status: ${statusText}\n` +
    `${record}`
  );
}

/**
 * Build a leaderboard embed for a specific rank range.
 * Uses embed fields for each rank slot to get the dashed separator effect.
 * Empty slots show as "Vacant".
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

  // Refresh expired headshots in the background (non-blocking)
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

  // Build a map of rank → player for easy lookup
  const playerMap = new Map<number, any>();
  for (const player of players) {
    if (player.rank !== null) {
      playerMap.set(player.rank, player);
    }
  }

  // Build embed fields for each rank slot (fills vacancies)
  const fields: { name: string; value: string; inline: boolean }[] = [];

  for (let rank = minRank; rank <= maxRank; rank++) {
    const player = playerMap.get(rank);
    const fieldText = player ? playerSlot(player) : vacantSlot(rank);

    // Use invisible character as field name for cleaner look
    fields.push({
      name: '\u200B',
      value: fieldText,
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x5865F2)
    .setTimestamp()
    .setFooter({ text: 'Updated in real-time • Challenge in #challenge-tickets' });

  // Add all rank slots as fields (Discord max is 25 fields)
  // Split into chunks of 25 if needed
  const maxFields = 25;
  if (fields.length <= maxFields) {
    embed.addFields(fields);
  } else {
    // For ranges > 25, combine multiple ranks per field
    const combined: { name: string; value: string; inline: boolean }[] = [];
    let currentChunk = '';
    let currentRank = minRank;

    for (const field of fields) {
      if (currentChunk.length + field.value.length > 1024) {
        combined.push({ name: '\u200B', value: currentChunk, inline: false });
        currentChunk = '';
      }
      if (currentChunk) currentChunk += '\n\n';
      currentChunk += field.value;
      currentRank++;
    }
    if (currentChunk) {
      combined.push({ name: '\u200B', value: currentChunk, inline: false });
    }
    embed.addFields(combined);
  }

  // Set thumbnail to top player's headshot in this range
  if (players.length > 0 && players[0].robloxHeadshotUrl) {
    embed.setThumbnail(players[0].robloxHeadshotUrl);
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
 * Debounced to max once per editDebounceMs to avoid rate limits.
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
 * Immediately refresh all leaderboard messages for a guild (bypasses debounce).
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
