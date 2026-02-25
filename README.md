# FastRoute Driver (Expo)

App React Native com Expo, inspirado nas telas do prototipo, para operacao de rotas e entregas.

## Funcionalidades implementadas

- Login via backend (`POST /login`) com refresh de sessão via Supabase SDK.
- Fluxo offline-first:
  - Operações salvas localmente (SQLite).
  - Fila de sync local para envio posterior.
  - Sync manual pela tela de Configurações.
  - Sync diário automático em horário configurável (padrão `19:00`).
- Lista de rotas e waypoints a partir do banco local.
- Importação de rota em modo offline (enfileira para sync posterior).
- Início/finalização de rota e atualização de waypoint em modo offline.
- Visualização da rota no mapa e telas de detalhamento.

## API

Base URL configurada:

`https://webhook.oliversoft.tech/webhook/`

Voce pode sobrescrever por variavel de ambiente:

`EXPO_PUBLIC_API_BASE_URL`

Refresh de token via Supabase SDK:

- `EXPO_PUBLIC_SUPABASE_URL=https://mbtwevtytgnlztaccygy.supabase.co`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY=<sua_anon_key>`

## Executar

1. Instale dependencias:
   - `npm install`
2. (Opcional) Copie `.env.example` para `.env` e ajuste a URL.
3. Android local (sem Metro em runtime):
   - `npm run android`
4. iOS local (sem Metro em runtime):
   - `npm run ios`
5. Opcional para desenvolvimento com Metro:
   - `npm run start`

## Estrutura principal

- `App.tsx`: bootstrap do app
- `src/navigation/`: stack navigator
- `src/screens/`: telas principais
- `src/api/`: APIs locais (offline) e APIs remotas (somente Sync Engine)
- `src/components/`: componentes reutilizaveis
- `src/offline/`: banco SQLite, fila local, Sync Engine e scheduler

## Observacoes

- O contrato usado pelo app segue a collection Postman `FastRouteApp.postman_collection.json`.
- O app não sincroniza apenas por haver internet; sincroniza somente de forma manual ou no horário diário configurado.
