import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN!;
const GUILD_ID = process.env.GUILD_ID!;

const LB_CHANNELS = [
  { id: process.env.LEADERBOARD_CHANNEL_1_ID!, title: '🏆 Top 10 Leaderboard', min: 1, max: 10 },
  { id: process.env.LEADERBOARD_CHANNEL_2_ID!, title: '⚔️ Top 20 Leaderboard', min: 11, max: 20 },
  { id: process.env.LEADERBOARD_CHANNEL_3_ID!, title: '🎖️ Top 30 Leaderboard', min: 21, max: 30 },
];

const TICKETS_CHANNEL_ID = process.env.TICKETS_CHANNEL_ID!;

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

async function main() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  await client.login(TOKEN);
  console.log(`Logged in as ${client.user?.tag}`);

  for (const lb of LB_CHANNELS) {
    if (!lb.id) continue;
    const channel = await client.channels.fetch(lb.id) as TextChannel;
    if (!channel) continue;

    // Build fields with vacant slots
    const fields: { name: string; value: string; inline: boolean }[] = [];
    for (let rank = lb.min; rank <= lb.max; rank++) {
      fields.push({ name: '\u200B', value: vacantSlot(rank), inline: false });
    }

    const embed = new EmbedBuilder()
      .setTitle(lb.title)
      .setColor(0x5865F2)
      .addFields(fields)
      .setTimestamp()
      .setFooter({ text: 'Updated in real-time • Challenge in #challenge-tickets' });

    // Try to edit the last bot message in the channel, otherwise send new
    const messages = await channel.messages.fetch({ limit: 10 });
    const lastBotMessage = messages.find((m) => m.author.id === client.user!.id);

    if (lastBotMessage) {
      await lastBotMessage.edit({ embeds: [embed] });
      console.log(`Updated "${lb.title}" in channel ${lb.id}`);
    } else {
      const message = await channel.send({ embeds: [embed] });
      console.log(`Sent "${lb.title}" to channel ${lb.id} (message: ${message.id})`);
    }
  }

  // Ticket panel
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
        new ButtonBuilder().setCustomId('btn_create_profile').setLabel('Create').setStyle(ButtonStyle.Success).setEmoji('📝'),
        new ButtonBuilder().setCustomId('btn_challenge').setLabel('Challenge').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
      );

      const messages = await channel.messages.fetch({ limit: 10 });
      const lastBotMessage = messages.find((m) => m.author.id === client.user!.id);

      if (lastBotMessage) {
        await lastBotMessage.edit({ embeds: [embed], components: [row] });
        console.log(`Updated ticket panel in channel ${TICKETS_CHANNEL_ID}`);
      } else {
        const message = await channel.send({ embeds: [embed], components: [row] });
        console.log(`Sent ticket panel to channel ${TICKETS_CHANNEL_ID} (message: ${message.id})`);
      }
    }
  }

  console.log('All messages updated with new format!');
  await client.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
