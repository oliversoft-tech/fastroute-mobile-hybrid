const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  await page.addInitScript(() => {
    window.alert = () => {};
  });

  await page.route('**/webhook/**', async (route) => {
    const req = route.request();
    const method = req.method();
    const url = req.url();

    if (url.endsWith('/webhook/login') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          auth_token: 'preview-token'
        })
      });
    }

    if (url.endsWith('/webhook/routes') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 102,
            cluster_id: 1,
            status: 'EM_ROTA',
            created_at: '2026-02-20T08:30:00.000Z'
          },
          {
            id: 101,
            cluster_id: 2,
            status: 'PENDENTE',
            created_at: '2026-02-20T08:00:00.000Z'
          }
        ])
      });
    }

    if (url.endsWith('/webhook/routes') && method === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 103,
          cluster_id: 3,
          status: 'PENDENTE',
          created_at: '2026-02-20T09:00:00.000Z'
        })
      });
    }

    if (url.endsWith('/webhook/routes/102') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 102,
          cluster_id: 1,
          status: 'EM_ROTA',
          created_at: '2026-02-20T08:30:00.000Z',
          waypoints: [
            { id: 11, route_id: 102, address_id: 1, seq_order: 1, status: 'EM_ROTA' },
            { id: 12, route_id: 102, address_id: 2, seq_order: 2, status: 'PENDENTE' },
            { id: 13, route_id: 102, address_id: 3, seq_order: 3, status: 'PENDENTE' }
          ]
        })
      });
    }

    if (url.endsWith('/webhook/routes/102/waypoints') && method === 'PATCH') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }

    if (url.endsWith('/webhook/route/import') && method === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          orders_created: 3,
          addresses_created: 3,
          routes_generated: 1
        })
      });
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('http://localhost:8081', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  await page.screenshot({ path: 'preview-login.png', fullPage: true });

  await page.getByText('Entrar no Sistema').first().click();
  await page.getByRole('heading', { name: 'Minhas Rotas' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'preview-routes.png', fullPage: true });

  await page.getByText('Criar Rota').nth(1).click();
  await page.getByText(/Importar arquivo de rota/i).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'preview-import.png', fullPage: true });

  await page.getByText('Voltar').first().click();
  await page.getByRole('heading', { name: 'Minhas Rotas' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
  await page.getByText('Rota #102').first().click();
  await page.getByText('Paradas').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'preview-detail.png', fullPage: true });

  await page.getByText('Rua do Brasil 50').first().click();
  await page.getByText('Marcar como ENTREGUE').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'preview-delivery.png', fullPage: true });

  await page.getByText(/Pr.*xima entrega/).first().click();
  await page.getByText('Paradas').first().waitFor({ timeout: 10000 });
  await page.getByText('Ver no mapa').first().click();
  await page.getByText('Paradas da rota').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'preview-map.png', fullPage: true });

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
