# FastRoute Driver (Expo)

App React Native com Expo, inspirado nas telas do prototipo, para operacao de rotas e entregas.

## Funcionalidades implementadas

- Login via `POST /login`
- Lista de rotas (`GET /routes`)
- Importacao de pedidos por arquivo (`POST /route/import`)
- Detalhes da rota com waypoints (`GET /routes/{id}`)
- Atualizacao de status da entrega (`PATCH /routes/{id}/waypoints`)
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
3. Rode o app:
   - `npm run start`
4. Abra no Expo Go (Android/iOS) ou simulador.

## Estrutura principal

- `App.tsx`: bootstrap do app
- `src/navigation/`: stack navigator
- `src/screens/`: telas principais
- `src/api/`: client HTTP e servicos
- `src/components/`: componentes reutilizaveis

## Observacoes

- O contrato OpenAPI nao traz coordenadas de endereco nos waypoints. Por isso o app usa um mapeamento local para demonstracao no mapa quando necessario.
- O status "FALHA" do prototipo foi tratado como retorno para `PENDENTE`, pois no YAML os status aceitos sao `PENDENTE`, `EM_ROTA` e `CONCLUIDO`.
