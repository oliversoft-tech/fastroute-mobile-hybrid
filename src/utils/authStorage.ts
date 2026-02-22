import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const AUTH_TOKEN_KEY = 'fastroute.auth_token';
const AUTH_EMAIL_KEY = 'fastroute.user_email';
const AUTH_REFRESH_TOKEN_KEY = 'fastroute.refresh_token';
const AUTH_USER_ID_KEY = 'fastroute.user_id';

let webTokenMemory: string | null = null;
let webEmailMemory: string | null = null;
let webRefreshTokenMemory: string | null = null;
let webUserIdMemory: string | null = null;

interface AuthSession {
  email: string;
  token: string;
  refreshToken?: string | null;
  userId?: string | null;
}

export async function saveAuthSession(session: AuthSession) {
  if (Platform.OS === 'web') {
    webEmailMemory = session.email;
    webTokenMemory = session.token;
    webRefreshTokenMemory = session.refreshToken ?? null;
    webUserIdMemory = session.userId ?? null;
    return;
  }

  await Promise.all([
    SecureStore.setItemAsync(AUTH_EMAIL_KEY, session.email),
    SecureStore.setItemAsync(AUTH_TOKEN_KEY, session.token),
    session.refreshToken
      ? SecureStore.setItemAsync(AUTH_REFRESH_TOKEN_KEY, session.refreshToken)
      : SecureStore.deleteItemAsync(AUTH_REFRESH_TOKEN_KEY),
    session.userId
      ? SecureStore.setItemAsync(AUTH_USER_ID_KEY, session.userId)
      : SecureStore.deleteItemAsync(AUTH_USER_ID_KEY)
  ]);
}

export async function loadAuthSession(): Promise<AuthSession | null> {
  if (Platform.OS === 'web') {
    if (webEmailMemory && webTokenMemory) {
      return {
        email: webEmailMemory,
        token: webTokenMemory,
        refreshToken: webRefreshTokenMemory,
        userId: webUserIdMemory
      };
    }

    return null;
  }

  const [email, token, refreshToken, userId] = await Promise.all([
    SecureStore.getItemAsync(AUTH_EMAIL_KEY),
    SecureStore.getItemAsync(AUTH_TOKEN_KEY),
    SecureStore.getItemAsync(AUTH_REFRESH_TOKEN_KEY),
    SecureStore.getItemAsync(AUTH_USER_ID_KEY)
  ]);

  if (!email || !token) {
    return null;
  }

  return { email, token, refreshToken, userId };
}

export async function clearAuthSession() {
  if (Platform.OS === 'web') {
    webEmailMemory = null;
    webTokenMemory = null;
    webRefreshTokenMemory = null;
    webUserIdMemory = null;
    return;
  }

  await Promise.all([
    SecureStore.deleteItemAsync(AUTH_EMAIL_KEY),
    SecureStore.deleteItemAsync(AUTH_TOKEN_KEY),
    SecureStore.deleteItemAsync(AUTH_REFRESH_TOKEN_KEY),
    SecureStore.deleteItemAsync(AUTH_USER_ID_KEY)
  ]);
}
