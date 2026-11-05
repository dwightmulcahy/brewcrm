export const E2E = {
  port: Number(process.env.E2E_PORT || 8091),
  mockPort: Number(process.env.E2E_MOCK_PORT || 9191),
  get baseURL() { return `http://127.0.0.1:${this.port}`; },
  admin: { email: 'e2e-admin@example.com', password: 'Brewery-tests-pass-26!' },
};
