import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import styles from '../../styles/appStyles';

export default function GroundedRagPanel({
  t,
  question,
  onChangeQuestion,
  onRun,
  onCancel,
  loading,
  result,
  descriptionPreview,
  onPrepareDescription,
  onChangeDescriptionPreview,
  onApplyDescription,
  onDiscardDescription,
}) {
  return (
    <View style={styles.toolCard}>
      <Text style={styles.toolTitle}>{t.aiGroundedTitle}</Text>
      <Text style={styles.aiSubtitle}>{t.aiGroundedDescription}</Text>
      <TextInput
        testID="grounded-question-input"
        accessibilityLabel={t.aiGroundedQuestion}
        value={question}
        onChangeText={onChangeQuestion}
        placeholder={t.aiGroundedQuestion}
        placeholderTextColor="#94a3b8"
        style={[styles.input, styles.groundedQuestionInput]}
        multiline
      />
      <View style={styles.actions}>
        <Pressable
          testID="grounded-run-button"
          accessibilityRole="button"
          accessibilityState={{ disabled: loading || !question.trim() }}
          disabled={loading || !question.trim()}
          onPress={onRun}
          style={[styles.primaryButton, (loading || !question.trim()) && styles.disabledButton]}
        >
          <Text style={styles.primaryButtonText}>
            {loading ? t.aiGroundedRunning : t.aiGroundedRun}
          </Text>
        </Pressable>
        {loading ? (
          <Pressable
            testID="grounded-cancel-button"
            accessibilityRole="button"
            onPress={onCancel}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>{t.cancel}</Text>
          </Pressable>
        ) : null}
      </View>

      {result?.status === 'insufficient_evidence' ? (
        <View testID="grounded-no-answer" accessibilityLiveRegion="polite" style={styles.groundedNoAnswer}>
          <Text style={styles.toolTitle}>{t.aiGroundedNoAnswer}</Text>
          <Text style={styles.aiSubtitle}>{t.aiGroundedNoAnswerHelp}</Text>
        </View>
      ) : null}

      {result?.status === 'answered' ? (
        <View accessibilityLiveRegion="polite" style={styles.analysisResult}>
          <Text style={styles.analysisText}>{result.answer}</Text>
          <Pressable
            testID="grounded-prepare-description"
            accessibilityRole="button"
            onPress={() => onPrepareDescription(result.answer)}
            style={styles.toolsButton}
          >
            <Text style={styles.toolsButtonText}>{t.aiGroundedUseDescription}</Text>
          </Pressable>
          <Text accessibilityRole="header" style={styles.analysisMeta}>{t.aiGroundedSources}</Text>
          {(result.citations || []).map((citation) => (
            <View key={citation.chunk_id} style={styles.groundedCitation}>
              <Text style={styles.cardTitle}>{citation.title}</Text>
              <Text style={styles.cardDescription}>{citation.excerpt}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {descriptionPreview !== null ? (
        <View style={styles.analysisResult}>
          <Text style={styles.analysisMeta}>{t.aiGroundedDescriptionPreview}</Text>
          <TextInput
            testID="grounded-description-preview"
            accessibilityLabel={t.aiGroundedDescriptionPreview}
            value={descriptionPreview}
            onChangeText={onChangeDescriptionPreview}
            style={[styles.input, styles.groundedPreviewInput]}
            multiline
          />
          <Text style={styles.aiSubtitle}>{t.aiGroundedConfirmHelp}</Text>
          <View style={styles.actions}>
            <Pressable
              testID="grounded-apply-description"
              accessibilityRole="button"
              accessibilityState={{ disabled: !descriptionPreview.trim() }}
              disabled={!descriptionPreview.trim()}
              onPress={onApplyDescription}
              style={[styles.primaryButton, !descriptionPreview.trim() && styles.disabledButton]}
            >
              <Text style={styles.primaryButtonText}>{t.aiGroundedConfirmDescription}</Text>
            </Pressable>
            <Pressable
              testID="grounded-discard-description"
              accessibilityRole="button"
              onPress={onDiscardDescription}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>{t.cancel}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
