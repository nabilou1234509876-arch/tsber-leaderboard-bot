/**
 * One-time bootstrap script: sends leaderboard embeds and ticket panel
 * to the configured Discord channels without requiring MongoDB.
 *
 * Usage: npx tsx scripts/bootstrap.ts
 */
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from 'discord.js';
import 'dotenv/config';

const TOKEN = process.env.DISCORD_TOKEN!;
const GUILD_ID = process.env.GUILD_ID!;

const LEADERBOARDS = [
  { channelId: process.env.LEADERBOARD_CHANNEL_1_ID!, title: '🏆 Top 10 Leaderboard', minRank: 1, maxRank: 10 },
  { channelId: process.env.LEADERBOARD_CHANNEL_2_ID!, title: '⚔️ Top 20 Leaderboard', minRank: 11, maxRank: 20 },
  { channelId: process.env.LEADERBOARD_CHANNEL_3_ID!, title: '🎖️ Top 30 Leaderboard', minRank: 21, maxRank: 30 },
];

const TICKETS_CHANNEL_ID = process.env.TICKETS_CHANNEL_ID!;

async function main() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  await client.login(TOKEN);
  console.log(`Logged in as ${client.user?.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);
  console.log(`Guild: ${guild.name}`);

  // ─── Send Leaderboard Embeds ───
  for (const lb of LEADERBOARDS) {
    if (!lb.channelId) {
      console.log(`Skipping "${lb.title}" — no channel ID`);
      continue;
    }

    const channel = await client.channels.fetch(lb.channelId) as TextChannel;
    if (!channel) {
      console.error(`Channel ${lb.channelId} not found`);
      continue;
    }

    const embed = new EmbedBuilder()
      .setTitle(lb.title)
      .setColor(0x5865F2)
      .setDescription('*No players ranked yet. Click **[Create]** in the challenge-tickets channel to register.*')
      .setTimestamp()
      .setFooter({ text: 'Updated in real-time • Challenge in #challenge-tickets' });

    const message = await channel.send({ embeds: [embed] });
    console.log(`✅ Sent "${lb.title}" to #${channel.name} (message ID: ${message.id})`);
  }

  // ─── Send Ticket Panel ───
  if (TICKETS_CHANNEL_ID) {
    const channel = await client.channels.fetch(TICKETS_CHANNEL_ID) as TextChannel;
    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle('🎫 Challenge Tickets')
        .setColor(0x5865F2)
        .setDescription(
          '**Welcome to the TSBER Challenge System!**\n\n' +
          '**Create** — Register your profile with Roblox verification to join the leaderboard.\n' +
          '**Challenge** — Select an eligible opponent to challenge and start a match ticket.\n\n' +
          'Click a button below to get started.',
        )
        .setFooter({ text: 'Persistent buttons • Work even after bot restarts' })
        .setTimestamp();

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_create_profile')
          .setLabel('Create')
          .setStyle(ButtonStyle.Success)
          .setEmoji('📝'),
        new ButtonBuilder()
          .setCustomId('btn_challenge')
          .setLabel('Challenge')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('⚔️'),
      );

      const message = await channel.send({ embeds: [embed], components: [row] });
      console.log(`✅ Sent ticket panel to #${channel.name} (message ID: ${message.id})`);
    }
  }

  console.log('\n✅ All messages sent! Check your Discord channels.');
  console.log('The bot will edit these messages in real-time once it connects to MongoDB.');

  client.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
