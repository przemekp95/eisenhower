import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default function LanguageSwitcher({ language, onChange }) {
  return (
    <View style={styles.container}>
      {['en', 'pl'].map((entry) => (
        <Pressable
          key={entry}
          onPress={() => onChange(entry)}
          style={[styles.button, language === entry && styles.buttonActive]}
        >
          <Text style={[styles.text, language === entry && styles.textActive]}>{entry.toUpperCase()}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 8,
  },
  button: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#1e293b',
  },
  buttonActive: {
    backgroundColor: '#14b8a6',
  },
  text: {
    color: '#e2e8f0',
    fontWeight: '600',
  },
  textActive: {
    color: '#042f2e',
  },
});
