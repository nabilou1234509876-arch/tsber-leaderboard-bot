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

// Hardcoded channel config — always works regardless of env vars
const LEADERBOARDS = [
  { channelId: '1509210175406604328', minRank: 1, maxRank: 10 },
  { channelId: '1509210720011554987', minRank: 11, maxRank: 20 },
  { channelId: '1509210811766276276', minRank: 21, maxRank: 30 },
];

const GUILD_ID = '1508900900381524089';

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
 * Build embeds for a rank range. Each rank = one embed with GIF.
 */
async function buildLeaderboardEmbeds(
  minRank: number,
  maxRank: number,
): Promise<EmbedBuilder[]> {
  const players = await Player.find({ guildId: GUILD_ID, rank: { $gte: minRank, $lte: maxRank } })
    .sort({ rank: 1 })
    .lean();

  // Refresh expired headshots in background
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
  for (let rank = minRank; rank <= maxRank && embeds.length < 10; rank++) {
    const player = playerMap.get(rank);
    const fieldName = player ? playerFieldName(player) : vacantFieldName(rank);
    const fieldValue = player ? playerFieldValue(player) : vacantFieldValue();

    const embed = new EmbedBuilder()
      .setColor(0x1a1a2e)
      .addFields({ name: fieldName, value: fieldValue, inline: false })
      .setImage(GIF_URL);

    embeds.push(embed);
  }

  // Thumbnail on first embed
  const topPlayer = players.find((p) => p.rank === minRank);
  if (topPlayer?.robloxHeadshotUrl && embeds.length > 0) {
    embeds[0].setThumbnail(topPlayer.robloxHeadshotUrl);
  }

  return embeds;
}

/**
 * Get the stored message ID for a channel from the database.
 */
async function getStoredMessageId(channelId: string): Promise<string | null> {
  const guildConfig = await getGuildConfig(GUILD_ID);
  const lb = guildConfig.leaderboards.find((l) => l.channelId === channelId);
  return lb?.messageId ?? null;
}

/**
 * Store a message ID in the database for a channel.
 */
async function storeMessageId(channelId: string, messageId: string): Promise<void> {
  const guildConfig = await getGuildConfig(GUILD_ID);
  let lb = guildConfig.leaderboards.find((l) => l.channelId === channelId);
  if (lb) {
    lb.messageId = messageId;
  } else {
    const config = LEADERBOARDS.find((l) => l.channelId === channelId);
    if (config) {
      guildConfig.leaderboards.push({
        channelId,
        messageId,
        minRank: config.minRank,
        maxRank: config.maxRank,
        title: '',
      });
    }
  }
  await guildConfig.save();
}

/**
 * Initialize leaderboard messages on bot startup.
 * For each channel: try to find bot's existing message and edit it.
 * If not found, send a new one. Store ID in database.
 */
export async function initLeaderboardMessages(client: Client): Promise<void> {
  for (const lb of LEADERBOARDS) {
    try {
      const channel = await client.channels.fetch(lb.channelId) as TextChannel;
      if (!channel) {
        logger.error(`Channel ${lb.channelId} not found`);
        continue;
      }

      const embeds = await buildLeaderboardEmbeds(lb.minRank, lb.maxRank);
      const storedId = await getStoredMessageId(lb.channelId);
      let messageFound = false;

      // Try stored message ID first
      if (storedId) {
        try {
          const message = await channel.messages.fetch(storedId);
          if (message && message.author.id === client.user!.id) {
            await message.edit({ embeds });
            logger.info(`Leaderboard ${lb.minRank}-${lb.maxRank}: edited existing message ${storedId}`);
            messageFound = true;
          }
        } catch {
          logger.warn(`Leaderboard ${lb.minRank}-${lb.maxRank}: stored message ID ${storedId} not found, searching...`);
        }
      }

      // Search channel for bot's embed message
      if (!messageFound) {
        const messages = await channel.messages.fetch({ limit: 20 });
        const botMsg = messages.find(
          (m) => m.author.id === client.user!.id && m.embeds.length > 0,
        );

        if (botMsg) {
          await botMsg.edit({ embeds });
          await storeMessageId(lb.channelId, botMsg.id);
          logger.info(`Leaderboard ${lb.minRank}-${lb.maxRank}: found and edited message ${botMsg.id}`);
          messageFound = true;
        }
      }

      // No message found — send new one
      if (!messageFound) {
        const message = await channel.send({ embeds });
        await storeMessageId(lb.channelId, message.id);
        logger.info(`Leaderboard ${lb.minRank}-${lb.maxRank}: sent new message ${message.id}`);
      }
    } catch (error) {
      logger.error(`Failed to init leaderboard ${lb.minRank}-${lb.maxRank}:`, error);
    }
  }
}

/**
 * Refresh all leaderboards immediately.
 * Reads message IDs from database, edits directly.
 * If edit fails, searches for the message or creates a new one.
 */
export async function refreshLeaderboard(_guildId?: string): Promise<void> {
  const client = (globalThis as any).client as Client | undefined;
  if (!client) {
    logger.error('REFRESH FAILED: Client not available on globalThis');
    return;
  }

  for (const lb of LEADERBOARDS) {
    try {
      const channel = await client.channels.fetch(lb.channelId) as TextChannel;
      if (!channel) {
        logger.error(`REFRESH FAILED: Channel ${lb.channelId} not found`);
        continue;
      }

      const embeds = await buildLeaderboardEmbeds(lb.minRank, lb.maxRank);
      const storedId = await getStoredMessageId(lb.channelId);
      let edited = false;

      // Try stored message ID
      if (storedId) {
        try {
          const message = await channel.messages.fetch(storedId);
          if (message && message.author.id === client.user!.id) {
            await message.edit({ embeds });
            edited = true;
            logger.info(`REFRESH: Leaderboard ${lb.minRank}-${lb.maxRank} updated via stored ID ${storedId}`);
          }
        } catch {
          // Stale ID — fall through
        }
      }

      // Search for bot message
      if (!edited) {
        const messages = await channel.messages.fetch({ limit: 20 });
        const botMsg = messages.find(
          (m) => m.author.id === client.user!.id && m.embeds.length > 0,
        );

        if (botMsg) {
          await botMsg.edit({ embeds });
          await storeMessageId(lb.channelId, botMsg.id);
          edited = true;
          logger.info(`REFRESH: Leaderboard ${lb.minRank}-${lb.maxRank} updated via search (message ${botMsg.id})`);
        }
      }

      // Create new message
      if (!edited) {
        const message = await channel.send({ embeds });
        await storeMessageId(lb.channelId, message.id);
        logger.info(`REFRESH: Leaderboard ${lb.minRank}-${lb.maxRank} created new message ${message.id}`);
      }
    } catch (error) {
      logger.error(`REFRESH FAILED: Leaderboard ${lb.minRank}-${lb.maxRank}:`, error);
    }
  }
}
