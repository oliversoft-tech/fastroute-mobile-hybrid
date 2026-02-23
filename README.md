# FastRoute Driver (Expo)

App React Native com Expo, inspirado nas telas do prototipo, para operacao de rotas e entregas.

## Funcionalidades implementadas

- Login via `POST /login`
- Lista de rotas (`GET /route`)
- Importacao de pedidos por arquivo (`POST /route/import`)
- Tela de arquivos locais e historico de importacoes (visual do prototipo)
- Detalhes de rota (`GET /route?route_id=...`)
- Iniciar rota (`PATCH /route/start?route_id=...`)
- Finalizar rota (`PATCH /route/finish?route_id=...`)
- Finalizar waypoint (`PATCH /waypoint/finish`)
- Visualizacao da rota no mapa
- Abrir parada no Google Maps

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
4. Opcional para desenvolvimento com Metro:
   - `npm run start`

## Estrutura principal

- `App.tsx`: bootstrap do app
- `src/navigation/`: stack navigator
- `src/screens/`: telas principais
- `src/api/`: client HTTP e servicos
- `src/components/`: componentes reutilizaveis

## Observacoes

- O contrato usado pelo app segue a collection Postman `FastRouteApp.postman_collection.json`.
- O app normaliza diferentes formatos de payload da API para manter a UI consistente.
