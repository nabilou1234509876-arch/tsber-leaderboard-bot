import { SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from './index.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { Player } from '../database/models/Player.js';
import { createSuccessEmbed, createErrorEmbed } from '../utils/embeds.js';
import { hasStaffPermission } from '../utils/permissions.js';
import { logger } from '../utils/logger.js';
import { refreshLeaderboard } from '../services/leaderboard.js';

export const setrank: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('setrank')
    .setDescription('Set a player\'s rank position')
    .addUserOption((option) =>
      option.setName('user').setDescription('The player to set rank for').setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName('rank')
        .setDescription('Rank position 1-30, or 0 for Unranked')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(30),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!hasStaffPermission(interaction.member as any)) {
      await interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'Only staff (Administrator) can use this command.')], ephemeral: true });
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    const rankValue = interaction.options.getInteger('rank', true);

    const guildId = interaction.guildId!;

    const player = await Player.findOne({ guildId, discordId: targetUser.id });
    if (!player) {
      await interaction.reply({ embeds: [createErrorEmbed('Player Not Found', `${targetUser.username} is not registered. They must click [Create] in the challenge-tickets channel first.`)], ephemeral: true });
      return;
    }

    const oldRank = player.rank;

    if (rankValue === 0) {
      player.rank = null;
      player.stage = 'Stage 0';
    } else {
      player.rank = rankValue;
      player.stage = 'Ranked';
    }

    await player.save();
    logger.info(`DB UPDATED: ${player.robloxUsername} rank set to ${player.rank} (was ${oldRank})`);

    // Refresh leaderboard immediately
    logger.info('Refreshing leaderboard now...');
    await refreshLeaderboard(guildId);
    logger.info('Leaderboard refresh complete.');

    const embed = createSuccessEmbed(
      'Rank Updated',
      `**${player.robloxUsername}**'s rank has been updated.\n\n**Previous:** ${oldRank ? `#${oldRank}` : 'Unranked'}\n**New:** ${player.rank ? `#${player.rank}` : 'Unranked'}\n\n*Leaderboard has been refreshed.*`,
    );

    await interaction.reply({ embeds: [embed] });
  },
};
