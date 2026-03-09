import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { Linking } from 'react-native';
import { loginRequest } from '../api/authApi';
import {
  setAuthSessionTokens,
  setOnSessionRefreshed,
  setOnUnauthorized,
  setTokenRefreshHandler
} from '../api/httpClient';
import { refreshWithSupabase } from '../api/supabaseClient';
import { resolveDriverUserIdFromAuthId } from '../api/supabaseDataApi';
import { clearAuthSession, loadAuthSession, saveAuthSession } from '../utils/authStorage';
import { invalidateRouteQueryCache } from '../state/routesQueryCache';
import { forceLegacyRouteHydration, maybeRunInitialAutoSync, syncNow } from '../offline/syncEngine';
import { forceE2ESeedData } from '../e2e/seedData';

const runtimeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process;

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

const E2E_BYPASS_LOGIN = parseBooleanEnv(
  process.env.EXPO_PUBLIC_E2E_BYPASS_LOGIN ?? runtimeProcess?.env?.EXPO_PUBLIC_E2E_BYPASS_LOGIN,
  false
);

interface AuthState {
  userEmail: string | null;
  userId: string | null;
  authToken: string | null;
  isReady: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [authToken, setAuthTokenState] = useState<string | null>(null);
  const [refreshToken, setRefreshTokenState] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const userEmailRef = useRef<string | null>(null);
  const userIdRef = useRef<string | null>(null);
  const e2eBootstrapInFlightRef = useRef(false);

  useEffect(() => {
    userEmailRef.current = userEmail;
  }, [userEmail]);

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  const applyE2EBootstrap = useCallback(async () => {
    if (e2eBootstrapInFlightRef.current) {
      return;
    }

    e2eBootstrapInFlightRef.current = true;
    try {
      setUserEmail('e2e@fastroute.test');
      setUserId('e2e-driver');
      setAuthTokenState('e2e-token');
      setRefreshTokenState(null);
      setAuthSessionTokens('e2e-token', null);
      await forceE2ESeedData();
    } finally {
      e2eBootstrapInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    async function restoreSession() {
      if (E2E_BYPASS_LOGIN) {
        await applyE2EBootstrap();
        setIsReady(true);
        return;
      }

      try {
        const session = await loadAuthSession();
        if (!session) {
          return;
        }

        let resolvedUserId = session.userId ?? null;
        try {
          const userIdFromUsersTable = await resolveDriverUserIdFromAuthId(session.userId ?? null);
          if (userIdFromUsersTable) {
            resolvedUserId = userIdFromUsersTable;
          }
        } catch {
          // Mantém o userId salvo localmente se a consulta ao Supabase falhar.
        }

        setUserEmail(session.email);
        setUserId(resolvedUserId);
        setAuthTokenState(session.token);
        setRefreshTokenState(session.refreshToken ?? null);
        setAuthSessionTokens(session.token, session.refreshToken ?? null);

        if (resolvedUserId !== session.userId) {
          await saveAuthSession({
            email: session.email,
            token: session.token,
            refreshToken: session.refreshToken ?? null,
            userId: resolvedUserId
          });
        }
      } finally {
        setIsReady(true);
      }
    }

    restoreSession();
  }, [applyE2EBootstrap]);

  useEffect(() => {
    const onUrl = ({ url }: { url: string }) => {
      if (!url) {
        return;
      }

      const normalized = url.toLowerCase();
      if (!normalized.includes('e2e/bootstrap')) {
        return;
      }

      void applyE2EBootstrap();
    };

    const subscription = Linking.addEventListener('url', onUrl);
    void Linking.getInitialURL().then((url) => {
      if (url) {
        onUrl({ url });
      }
    });

    return () => {
      subscription.remove();
    };
  }, [applyE2EBootstrap]);

  const login = useCallback(async (email: string, password: string) => {
    const tokens = await loginRequest(email, password);
    invalidateRouteQueryCache();
    let resolvedUserId = tokens.userId;
    try {
      const userIdFromUsersTable = await resolveDriverUserIdFromAuthId(tokens.userId);
      if (userIdFromUsersTable) {
        resolvedUserId = userIdFromUsersTable;
      }
    } catch {
      // Fallback para o user_id recebido no login quando consulta relacional falhar.
    }

    setUserEmail(email);
    setUserId(resolvedUserId);
    setAuthTokenState(tokens.accessToken);
    setRefreshTokenState(tokens.refreshToken);
    setAuthSessionTokens(tokens.accessToken, tokens.refreshToken);
    try {
      await saveAuthSession({
        email,
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        userId: resolvedUserId
      });
    } catch (storageError) {
      console.warn('[Auth] Falha ao persistir sessão após login:', storageError);
    }

    try {
      const syncResult = await syncNow('manual', { fullPull: true });
      if (syncResult.ok && syncResult.pulledRoutes === 0) {
        await forceLegacyRouteHydration();
      }
    } catch (syncError) {
      console.warn('[Auth] Falha ao sincronizar rotas após login:', syncError);
    }
  }, []);

  const logout = useCallback(async () => {
    await clearAuthSession();
    setUserEmail(null);
    setUserId(null);
    setAuthTokenState(null);
    setRefreshTokenState(null);
    setAuthSessionTokens(null, null);
    invalidateRouteQueryCache();
  }, []);

  useEffect(() => {
    setOnUnauthorized(() => {
      void logout();
    });

    setOnSessionRefreshed(async (nextAccessToken, nextRefreshToken) => {
      const currentEmail = userEmailRef.current;
      const currentUserId = userIdRef.current;
      if (!currentEmail) {
        return;
      }

      setAuthTokenState(nextAccessToken);
      setRefreshTokenState(nextRefreshToken);
      try {
        await saveAuthSession({
          email: currentEmail,
          token: nextAccessToken,
          refreshToken: nextRefreshToken,
          userId: currentUserId
        });
      } catch (storageError) {
        console.warn('[Auth] Falha ao persistir sessão após refresh:', storageError);
      }
    });
    setTokenRefreshHandler((refreshToken) => refreshWithSupabase(refreshToken));

    return () => {
      setOnUnauthorized(null);
      setOnSessionRefreshed(null);
      setTokenRefreshHandler(null);
    };
  }, [logout]);

  useEffect(() => {
    if (!isReady || !authToken || E2E_BYPASS_LOGIN) {
      return;
    }
    void maybeRunInitialAutoSync();
  }, [authToken, isReady]);

  const value = useMemo(
    () => ({
      userEmail,
      userId,
      authToken,
      isReady,
      login,
      logout
    }),
    [authToken, isReady, login, logout, refreshToken, userEmail, userId]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth deve ser usado dentro de AuthProvider');
  }

  return context;
}
