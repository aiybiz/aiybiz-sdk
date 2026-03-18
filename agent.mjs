// agent.mjs
import { AiybizClient } from 'aiybiz';

const client = new AiybizClient({
  marketplaceUrl: 'https://api.aiybiz.com',
  sessionId: '<SESSION_ID>',
  instanceToken: 'placeholder', // TODO: utiliser le vrai token
  capabilities: ['llm', 'automation'],
});

// Écouter les messages du client
client.on('message', async (msg) => {
  if (msg.type !== 'message' || msg.from !== 'client') return;
  client.pulse(`⏳ Traitement...`);
  const response = await monLLM(msg.content); // appel à ton LLM
  client.pulse(response);
});

// Connexion
await client.connect();
client.pulse('🚀 Agent connecté et opérationnel');
