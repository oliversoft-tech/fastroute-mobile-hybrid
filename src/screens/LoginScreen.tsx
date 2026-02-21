import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { PrimaryButton } from '../components/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import { getApiError } from '../api/httpClient';

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

export function LoginScreen({}: Props) {
  const { login } = useAuth();
  const [email, setEmail] = useState('zezinho@hotmail.com');
  const [password, setPassword] = useState('12345');
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    if (!email.includes('@') || password.length < 4) {
      Alert.alert('Dados inválidos', 'Informe um e-mail válido e senha com ao menos 4 caracteres.');
      return;
    }

    try {
      setLoading(true);
      await login(email, password);
    } catch (error) {
      Alert.alert('Falha no login', getApiError(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.wrapper}
    >
      <View style={styles.card}>
        <View style={styles.logoContainer}>
          <Text style={styles.logoIcon}>FR</Text>
        </View>

        <Text style={styles.title}>FastRoute</Text>
        <Text style={styles.subtitle}>Rotas otimizadas para motoristas</Text>

        <View style={styles.form}>
          <Text style={styles.label}>E-mail</Text>
          <TextInput
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            style={styles.input}
            placeholder="seu@email.com"
            placeholderTextColor={colors.textSecondary}
          />

          <Text style={styles.label}>Senha</Text>
          <TextInput
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            style={styles.input}
            placeholder="******"
            placeholderTextColor={colors.textSecondary}
          />

          <PrimaryButton
            label="Entrar no Sistema"
            onPress={onSubmit}
            loading={loading}
            style={styles.submitButton}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    padding: 20
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 24,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border
  },
  logoContainer: {
    width: 54,
    height: 54,
    borderRadius: 14,
    alignSelf: 'center',
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14
  },
  logoIcon: {
    color: '#fff',
    fontSize: 24
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
    color: colors.textPrimary
  },
  subtitle: {
    marginTop: 6,
    textAlign: 'center',
    color: colors.textSecondary,
    marginBottom: 22
  },
  form: {
    gap: 8
  },
  label: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase'
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.textPrimary,
    backgroundColor: '#fff'
  },
  submitButton: {
    marginTop: 14
  }
});
