import 'react-native-gesture-handler';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { AuthProvider } from './src/context/AuthContext';
import { AppNavigator } from './src/navigation/AppNavigator';
import { initializeLocalDb } from './src/offline/localDb';
import { startOfflineSyncScheduler, stopOfflineSyncScheduler } from './src/offline/syncScheduler';

export default function App() {
  useEffect(() => {
    void initializeLocalDb();
    startOfflineSyncScheduler();
    return () => {
      stopOfflineSyncScheduler();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <NavigationContainer>
          <StatusBar style="dark" />
          <AppNavigator />
        </NavigationContainer>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
