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

const GIF_URL = 'https://cdn.discordapp.com/attachments/1409616969770205296/1466903491795488810/asa_3_1.gif?ex=6a2dc756&is=6a2c75d6&hm=94ffb671b92a4fef04c6606613ae41c7e7131b6912cdd8cb714dbf268814684e&';

let editTimer: NodeJS.Timeout | null = null;
const pendingGuilds = new Set<string>();

function playerFieldName(player: any): string {
  const rank = player.rank ?? 0;
  const nameLink = robloxProfileLink(player.robloxUsername, player.robloxId);
  return `**#${rank}**  ${nameLink}`;
}

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

function vacantFieldName(rank: number): string {
  return `**#${rank}**  Vacant`;
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

/**
 * Build an array of embeds for a rank range.
 * Each rank = one embed with GIF image between entries.
 * Max 10 embeds per message (Discord limit).
 */
async function buildLeaderboardEmbeds(
  guildId: string,
  minRank: number,
  maxRank: number,
  title: string,
): Promise<EmbedBuilder[]> {
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

  const playerMap = new Map<number, any>();
  for (const player of players) {
    if (player.rank !== null) {
      playerMap.set(player.rank, player);
    }
  }

  const embeds: EmbedBuilder[] = [];
  const ranks: number[] = [];
  for (let r = minRank; r <= maxRank; r++) ranks.push(r);

  // Max 10 embeds per message — each rank gets its own embed with GIF
  // Discord limit is 10 embeds, so max 10 ranks per message
  for (let i = 0; i < ranks.length && embeds.length < 10; i++) {
    const rank = ranks[i];
    const player = playerMap.get(rank);
    const fieldName = player ? playerFieldName(player) : vacantFieldName(rank);
    const fieldValue = player ? playerFieldValue(player) : vacantFieldValue();

    const embed = new EmbedBuilder().setColor(0x1a1a2e);

    // Every embed gets the rank + GIF separator (including the last one)
    embed
      .addFields({ name: fieldName, value: fieldValue, inline: false })
      .setImage(GIF_URL);

    embeds.push(embed);
  }

  // Set thumbnail on first embed to #1 player's headshot
  const topPlayer = players.find((p) => p.rank === minRank);
  if (topPlayer?.robloxHeadshotUrl && embeds.length > 0) {
    embeds[0].setThumbnail(topPlayer.robloxHeadshotUrl);
  }

  return embeds;
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

      const embeds = await buildLeaderboardEmbeds(guildId, lb.minRank, lb.maxRank, lb.title);

      if (lb.messageId) {
        try {
          const message = await channel.messages.fetch(lb.messageId);
          await message.edit({ embeds });
          logger.info(`Leaderboard "${lb.title}" message updated`);
          continue;
        } catch {
          logger.warn(`Existing leaderboard message for "${lb.title}" not found, creating new one`);
        }
      }

      const message = await channel.send({ embeds });
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
      const embeds = await buildLeaderboardEmbeds(guildId, lb.minRank, lb.maxRank, lb.title);
      await message.edit({ embeds });
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
