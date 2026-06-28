import { EmbedBuilder, TextChannel, type Client } from 'discord.js';
import { Player } from '../database/models/Player.js';
import { getGuildConfig } from '../database/models/GuildConfig.js';
import { PlayerStatus } from '../types/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import {
  getStatusText,
  robloxProfileLink,
} from '../utils/formatting.js';
import { fetchRobloxHeadshot, isHeadshotExpired } from './rover.js';

let editTimer: NodeJS.Timeout | null = null;
const pendingGuilds = new Set<string>();

/**
 * Build a player's field value (stats block).
 * The field name is the rank + username header.
 * The field value is the stats + gradient bar.
 */
function playerFieldValue(player: any): string {
  const statusText = getStatusText(player.status as PlayerStatus);
  const region = player.region ?? '-';
  const stage = player.stage || '-';
  const mention = `<@${player.discordId}>`;

  return (
    `ID: ${player.robloxId}\n` +
    `${mention}\n` +
    `<< | .${player.robloxUsername}. | >>\n` +
    `Region: ${region}\n` +
    `Stage: **${stage}**\n` +
    `Status: ${statusText}\n` +
    `wins: ${player.wins} losses: ${player.losses}`
  );
}

function vacantFieldValue(): string {
  return (
    `ID: —\n` +
    `*No player registered*\n` +
    `<< | .vacant. | >>\n` +
    `Region: —\n` +
    `Stage: —\n` +
    `Status: Empty\n` +
    `wins: 0 losses: 0`
  );
}

function playerFieldName(player: any): string {
  const rank = player.rank ?? 0;
  let medal = '';
  if (rank === 1) medal = '🥇 ';
  else if (rank === 2) medal = '🥈 ';
  else if (rank === 3) medal = '🥉 ';
  const nameLink = robloxProfileLink(player.robloxUsername, player.robloxId);
  return `${medal}**#${rank}**  ${nameLink}`;
}

function vacantFieldName(rank: number): string {
  return `**#${rank}**  Vacant`;
}

/**
 * Build a leaderboard embed for a specific rank range.
 * Each rank = one embed field (gives native Discord field separator lines + spacing).
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

  // Build embed fields — each rank is its own field
  const fields: { name: string; value: string; inline: boolean }[] = [];

  for (let rank = minRank; rank <= maxRank; rank++) {
    const player = playerMap.get(rank);
    if (player) {
      fields.push({
        name: playerFieldName(player),
        value: playerFieldValue(player),
        inline: false,
      });
    } else {
      fields.push({
        name: vacantFieldName(rank),
        value: vacantFieldValue(),
        inline: false,
      });
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x1a1a2e)
    .setTimestamp()
    .setFooter({ text: 'Click a username to view their Roblox profile • Updated in real-time' });

  // Discord max 25 fields per embed
  embed.addFields(fields.slice(0, 25));

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
