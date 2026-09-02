// Public barrel for the console app shell. Consumers (app/(console)/console-client.tsx and
// App.test.tsx) import from "./App"; the exact public surface — AuthProvider,
// AuthProviderProps, ConsoleRoutes — must stay identical. No logic lives here.
export { AuthProvider, type AuthProviderProps } from "./auth-session";
export { ConsoleRoutes } from "./console-routes";
