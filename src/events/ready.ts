import type { Client } from 'discord.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { commands } from '../commands/index.js';
import { getGuildConfig } from '../database/models/GuildConfig.js';
import { initLeaderboardMessages } from '../services/leaderboard.js';
import { setupTicketPanel } from '../services/ticketPanel.js';
import { REST, Routes } from 'discord.js';

export const name = 'ready';
export const once = true;

export async function execute(client: Client): Promise<void> {
  logger.info(`Logged in as ${client.user?.tag}`);

  // Store client globally for services that need it (leaderboard refresh)
  (globalThis as any).client = client;

  // Register slash commands
  try {
    const rest = new REST({ version: '10' }).setToken(config.token);
    const commandData = commands.map((cmd) => cmd.data.toJSON());

    if (config.guildId) {
      await rest.put(
        Routes.applicationGuildCommands(client.user!.id, config.guildId),
        { body: commandData },
      );
      logger.info(`Registered ${commandData.length} guild slash commands`);
    } else {
      await rest.put(
        Routes.applicationCommands(client.user!.id),
        { body: commandData },
      );
      logger.info(`Registered ${commandData.length} global slash commands`);
    }
  } catch (error) {
    logger.error('Failed to register slash commands:', error);
  }

  // Initialize for each guild the bot is in
  for (const [guildId, guild] of client.guilds.cache) {
    logger.info(`Setting up guild: ${guild.name} (${guildId})`);

    const guildConfig = await getGuildConfig(guildId);
    let updated = false;

    // Sync leaderboard channels from config
    const configLeaderboards = config.channels.leaderboardChannels.map((ch) => ({
      channelId: ch.id,
      messageId: null as string | null,
      minRank: ch.minRank,
      maxRank: ch.maxRank,
      title: ch.title,
    }));

    // Only update if the channel list changed
    const existingChannels = guildConfig.leaderboards.map((l) => l.channelId).join(',');
    const newChannels = configLeaderboards.map((l) => l.channelId).join(',');
    if (existingChannels !== newChannels) {
      // Preserve existing message IDs where channels match
      for (const newLb of configLeaderboards) {
        const existing = guildConfig.leaderboards.find((l) => l.channelId === newLb.channelId);
        if (existing) {
          newLb.messageId = existing.messageId;
        }
      }
      guildConfig.leaderboards = configLeaderboards;
      updated = true;
    }

    if (config.channels.ticketsChannelId && guildConfig.ticketsChannelId !== config.channels.ticketsChannelId) {
      guildConfig.ticketsChannelId = config.channels.ticketsChannelId;
      updated = true;
    }
    if (config.channels.ticketsCategoryId && guildConfig.ticketsCategoryId !== config.channels.ticketsCategoryId) {
      guildConfig.ticketsCategoryId = config.channels.ticketsCategoryId;
      updated = true;
    }
    if (config.roles.refereesRoleId && guildConfig.refereesRoleId !== config.roles.refereesRoleId) {
      guildConfig.refereesRoleId = config.roles.refereesRoleId;
      updated = true;
    }
    if (config.roles.staffRoleIds.length > 0 && guildConfig.staffRoleIds.join(',') !== config.roles.staffRoleIds.join(',')) {
      guildConfig.staffRoleIds = config.roles.staffRoleIds;
      updated = true;
    }
    if (config.channels.loaChannelId && guildConfig.loaChannelId !== config.channels.loaChannelId) {
      guildConfig.loaChannelId = config.channels.loaChannelId;
      updated = true;
    }
    if (updated) {
      await guildConfig.save();
      logger.info(`Updated guild config for ${guild.name}`);
    }

    // Initialize leaderboard messages — always runs, hardcoded channels
    try {
      await initLeaderboardMessages(client);
    } catch (error) {
      logger.error(`Failed to init leaderboards:`, error);
    }

    // Initialize ticket panel
    if (guildConfig.ticketsChannelId) {
      try {
        await setupTicketPanel(client, guildId);
      } catch (error) {
        logger.error(`Failed to init ticket panel for guild ${guildId}:`, error);
      }
    }
  }

  logger.info('Bot is ready.');
}
