import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { RootStackParamList } from './types';
import { LoginScreen } from '../screens/LoginScreen';
import { RoutesScreen } from '../screens/RoutesScreen';
import { ImportRouteScreen } from '../screens/ImportRouteScreen';
import { RouteDetailScreen } from '../screens/RouteDetailScreen';
import { DeliveryScreen } from '../screens/DeliveryScreen';
import { MapScreen } from '../screens/MapScreen';
import { colors } from '../theme/colors';
import { useAuth } from '../context/AuthContext';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function AppNavigator() {
  const { userEmail, isReady } = useAuth();

  if (!isReady) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  }

  return (
    <Stack.Navigator
      screenOptions={{
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.textPrimary,
        contentStyle: { backgroundColor: colors.background }
      }}
    >
      {!userEmail ? (
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      ) : (
        <>
          <Stack.Screen name="Routes" component={RoutesScreen} options={{ title: 'Minhas Rotas' }} />
          <Stack.Screen
            name="ImportRoute"
            component={ImportRouteScreen}
            options={{ title: 'Importar Rota' }}
          />
          <Stack.Screen
            name="RouteDetail"
            component={RouteDetailScreen}
            options={({ route }) => ({ title: `Rota #${route.params.routeId}` })}
          />
          <Stack.Screen name="Delivery" component={DeliveryScreen} options={{ title: 'Entrega' }} />
          <Stack.Screen name="Map" component={MapScreen} options={{ title: 'Mapa da Rota' }} />
        </>
      )}
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background
  }
});
