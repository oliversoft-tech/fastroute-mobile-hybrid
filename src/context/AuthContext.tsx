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
import { loginRequest } from '../api/authApi';
import {
  setAuthSessionTokens,
  setOnSessionRefreshed,
  setOnUnauthorized,
  setTokenRefreshHandler
} from '../api/httpClient';
import { refreshWithSupabase } from '../api/supabaseClient';
import { clearAuthSession, loadAuthSession, saveAuthSession } from '../utils/authStorage';

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

  useEffect(() => {
    userEmailRef.current = userEmail;
  }, [userEmail]);

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  useEffect(() => {
    async function restoreSession() {
      try {
        const session = await loadAuthSession();
        if (!session) {
          return;
        }

        setUserEmail(session.email);
        setUserId(session.userId ?? null);
        setAuthTokenState(session.token);
        setRefreshTokenState(session.refreshToken ?? null);
        setAuthSessionTokens(session.token, session.refreshToken ?? null);
      } finally {
        setIsReady(true);
      }
    }

    restoreSession();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const tokens = await loginRequest(email, password);
    await saveAuthSession({
      email,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      userId: tokens.userId
    });
    setUserEmail(email);
    setUserId(tokens.userId);
    setAuthTokenState(tokens.accessToken);
    setRefreshTokenState(tokens.refreshToken);
    setAuthSessionTokens(tokens.accessToken, tokens.refreshToken);
  }, []);

  const logout = useCallback(async () => {
    await clearAuthSession();
    setUserEmail(null);
    setUserId(null);
    setAuthTokenState(null);
    setRefreshTokenState(null);
    setAuthSessionTokens(null, null);
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
      await saveAuthSession({
        email: currentEmail,
        token: nextAccessToken,
        refreshToken: nextRefreshToken,
        userId: currentUserId
      });
    });
    setTokenRefreshHandler((refreshToken) => refreshWithSupabase(refreshToken));

    return () => {
      setOnUnauthorized(null);
      setOnSessionRefreshed(null);
      setTokenRefreshHandler(null);
    };
  }, [logout]);

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
