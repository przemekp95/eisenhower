import React from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import styles from '../styles/appStyles';

export default function TaskComposer({
  newTask,
  onChangeTask,
  onAddTask,
  onSuggest,
  onScan,
  onOpenAITools,
  suggestDisabled,
  scanDisabled,
  t,
}) {
  return (
    <View style={styles.form}>
      <TextInput
        value={newTask.title}
        onChangeText={(value) => onChangeTask('title', value)}
        placeholder={t.titlePlaceholder}
        placeholderTextColor="#94a3b8"
        style={styles.input}
      />
      <TextInput
        value={newTask.description}
        onChangeText={(value) => onChangeTask('description', value)}
        placeholder={t.descriptionPlaceholder}
        placeholderTextColor="#94a3b8"
        style={styles.input}
      />
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>{t.urgent}</Text>
        <Switch
          testID="new-task-urgent-switch"
          value={newTask.urgent}
          onValueChange={(value) => onChangeTask('urgent', value)}
        />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>{t.important}</Text>
        <Switch
          testID="new-task-important-switch"
          value={newTask.important}
          onValueChange={(value) => onChangeTask('important', value)}
        />
      </View>
      <View style={styles.actions}>
        <Pressable testID="add-task-button" onPress={onAddTask} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>{t.addTask}</Text>
        </Pressable>
        <Pressable
          testID="suggest-task-button"
          onPress={onSuggest}
          disabled={suggestDisabled}
          style={[styles.secondaryButton, suggestDisabled && styles.disabledButton]}
        >
          <Text style={styles.secondaryButtonText}>{t.suggest}</Text>
        </Pressable>
        <Pressable
          testID="scan-task-button"
          onPress={onScan}
          disabled={scanDisabled}
          style={[styles.secondaryButton, scanDisabled && styles.disabledButton]}
        >
          <Text style={styles.secondaryButtonText}>{t.scan}</Text>
        </Pressable>
        <Pressable
          testID="open-ai-tools-button"
          onPress={onOpenAITools}
          style={styles.toolsButton}
        >
          <Text style={styles.toolsButtonText}>{t.aiTools}</Text>
        </Pressable>
      </View>
    </View>
  );
}
