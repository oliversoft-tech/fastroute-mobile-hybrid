import { ActivityIndicator, Pressable, StyleSheet, Text, ViewStyle } from 'react-native';
import { colors } from '../theme/colors';

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'success' | 'danger' | 'neutral';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}

const variants = {
  primary: colors.primary,
  success: colors.success,
  danger: colors.danger,
  neutral: colors.neutral
};

export function PrimaryButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style
}: PrimaryButtonProps) {
  const backgroundColor = variants[variant];

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor },
        (disabled || loading) && styles.disabled,
        pressed && !(disabled || loading) && styles.pressed,
        style
      ]}
    >
      {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.text}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  text: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15
  },
  disabled: {
    opacity: 0.55
  },
  pressed: {
    opacity: 0.88
  }
});
