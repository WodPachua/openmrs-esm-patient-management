import { type Dispatch, useEffect, useMemo, useState } from 'react';
import {
  type FetchResponse,
  type OpenmrsResource,
  getSynchronizationItems,
  openmrsFetch,
  restBaseUrl,
  useConfig,
  usePatient,
} from '@openmrs/esm-framework';
import camelCase from 'lodash-es/camelCase';
import dayjs from 'dayjs';
import useSWR from 'swr';
import { v4 } from 'uuid';
import { type RegistrationConfig } from '../config-schema';
import { patientRegistration } from '../constants';
import {
  type Encounter,
  type FormValues,
  type PatientIdentifierResponse,
  type PatientRegistration,
  type PatientUuidMapType,
  type PersonAttributeResponse,
} from './patient-registration.types';
import {
  getAddressFieldValuesFromFhirPatient,
  getFormValuesFromFhirPatient,
  getIdentifierFieldValuesFromFhirPatient,
  getPatientUuidMapFromFhirPatient,
  getPhonePersonAttributeValueFromFhirPatient,
  latestFirstEncounter,
} from './patient-registration-utils';
import { useInitialPatientRelationships } from './section/patient-relationships/relationships.resource';
import { useMpiPatient } from './mpi/mpi-patient.resource';

interface DeathInfoResults {
  uuid: string;
  display: string;
  causeOfDeath: OpenmrsResource | null;
  dead: boolean;
  deathDate: string;
  causeOfDeathNonCoded: string | null;
}

export function useInitialFormValuesLocal(patientUuid: string): [FormValues, Dispatch<FormValues>] {
  const { freeTextFieldConceptUuid, fieldConfigurations } = useConfig<RegistrationConfig>();
  const { isLoading: isLoadingPatientToEdit, patient: patientToEdit } = usePatient(patientUuid);
  const { data: deathInfo, isLoading: isLoadingDeathInfo } = useInitialPersonDeathInfo(patientUuid);
  const { data: attributes, isLoading: isLoadingAttributes } = useInitialPersonAttributes(patientUuid);
  const { data: identifiers, isLoading: isLoadingIdentifiers } = useInitialPatientIdentifiers(patientUuid);
  const { data: relationships, isLoading: isLoadingRelationships } = useInitialPatientRelationships(patientUuid);
  const { data: encounters } = useInitialEncounters(patientUuid, patientToEdit);

  const [initialFormValues, setInitialFormValues] = useState<FormValues>({
    patientUuid: v4(),
    givenName: '',
    middleName: '',
    familyName: '',
    additionalGivenName: '',
    additionalMiddleName: '',
    additionalFamilyName: '',
    addNameInLocalLanguage: false,
    gender: '',
    birthdate: null,
    yearsEstimated: 0,
    monthsEstimated: 0,
    birthdateEstimated: false,
    telephoneNumber: '',
    isDead: false,
    deathDate: undefined,
    deathTime: undefined,
    deathTimeFormat: 'AM',
    deathCause: '',
    nonCodedCauseOfDeath: '',
    relationships: [],
    identifiers: {},
    address: {},
  });

  useEffect(() => {
    (async () => {
      if (patientToEdit) {
        const birthdateEstimated = !/^\d{4}-\d{2}-\d{2}$/.test(patientToEdit.birthDate);
        const [years = 0, months = 0] = patientToEdit.birthDate.split('-').map((val) => parseInt(val));
        // Please refer: https://github.com/openmrs/openmrs-esm-patient-management/pull/697#issuecomment-1562706118
        const estimatedMonthsAvailable = patientToEdit.birthDate.split('-').length > 1;
        const yearsEstimated = birthdateEstimated ? Math.floor(dayjs().diff(patientToEdit.birthDate, 'month') / 12) : 0;
        const monthsEstimated =
          birthdateEstimated && estimatedMonthsAvailable ? dayjs().diff(patientToEdit.birthDate, 'month') % 12 : 0;

        setInitialFormValues({
          ...initialFormValues,
          ...getFormValuesFromFhirPatient(patientToEdit),
          address: getAddressFieldValuesFromFhirPatient(patientToEdit),
          ...getPhonePersonAttributeValueFromFhirPatient(patientToEdit, fieldConfigurations.phone.personAttributeUuid),
          birthdateEstimated: !/^\d{4}-\d{2}-\d{2}$/.test(patientToEdit.birthDate),
          yearsEstimated,
          monthsEstimated,
        });
      } else if (!isLoadingPatientToEdit && patientUuid) {
        const registration = await getPatientRegistration(patientUuid);

        if (!registration._patientRegistrationData.formValues) {
          console.error(
            `Found a queued offline patient registration for patient ${patientUuid}, but without form values. Not using these values.`,
          );
          return;
        }

        setInitialFormValues(registration._patientRegistrationData.formValues);
      }
    })();
  }, [
    initialFormValues,
    isLoadingPatientToEdit,
    patientToEdit,
    patientUuid,
    fieldConfigurations.phone.personAttributeUuid,
  ]);

  // Set initial patient death info
  useEffect(() => {
    if (!isLoadingDeathInfo && deathInfo?.dead) {
      const deathDatetime = deathInfo.deathDate || null;
      const deathDate = deathDatetime ? new Date(deathDatetime) : undefined;
      const time = deathDate ? dayjs(deathDate).format('hh:mm') : undefined;
      const timeFormat = deathDate ? (dayjs(deathDate).hour() >= 12 ? 'PM' : 'AM') : 'AM';
      setInitialFormValues((initialFormValues) => ({
        ...initialFormValues,
        isDead: deathInfo.dead || false,
        deathDate: deathDate,
        deathTime: time,
        deathTimeFormat: timeFormat,
        deathCause: deathInfo.causeOfDeathNonCoded ? freeTextFieldConceptUuid : deathInfo.causeOfDeath?.uuid,
        nonCodedCauseOfDeath: deathInfo.causeOfDeathNonCoded,
      }));
    }
  }, [isLoadingDeathInfo, deathInfo, setInitialFormValues, freeTextFieldConceptUuid]);

  // Set initial patient relationships
  useEffect(() => {
    if (!isLoadingRelationships && relationships) {
      setInitialFormValues((initialFormValues) => ({
        ...initialFormValues,
        relationships,
      }));
    }
  }, [isLoadingRelationships, relationships, setInitialFormValues]);

  // Set Initial patient identifiers
  useEffect(() => {
    if (!isLoadingIdentifiers && identifiers) {
      setInitialFormValues((initialFormValues) => ({
        ...initialFormValues,
        identifiers,
      }));
    }
  }, [isLoadingIdentifiers, identifiers, setInitialFormValues]);

  // Set Initial person attributes
  useEffect(() => {
    if (!isLoadingAttributes && attributes) {
      let personAttributes = {};
      attributes.forEach((attribute) => {
        personAttributes[attribute.attributeType.uuid] =
          attribute.attributeType.format === 'org.openmrs.Concept' && typeof attribute.value === 'object'
            ? attribute.value?.uuid
            : attribute.value;
      });

      setInitialFormValues((initialFormValues) => ({
        ...initialFormValues,
        attributes: personAttributes,
      }));
    }
  }, [attributes, setInitialFormValues, isLoadingAttributes]);

  // Set Initial registration encounters
  useEffect(() => {
    if (patientToEdit && encounters) {
      setInitialFormValues((initialFormValues) => ({
        ...initialFormValues,
        obs: encounters as Record<string, string>,
      }));
    }
  }, [encounters, patientToEdit]);

  return [initialFormValues, setInitialFormValues];
}

export function useMpiInitialFormValues(patientUuid: string): [FormValues, Dispatch<FormValues>] {
  const { fieldConfigurations } = useConfig<RegistrationConfig>();
  const { isLoading: isLoadingMpiPatient, patient: mpiPatient } = useMpiPatient(patientUuid);

  const [initialMPIFormValues, setInitialMPIFormValues] = useState<FormValues>({
    patientUuid: v4(),
    givenName: '',
    middleName: '',
    familyName: '',
    additionalGivenName: '',
    additionalMiddleName: '',
    additionalFamilyName: '',
    addNameInLocalLanguage: false,
    gender: '',
    birthdate: null,
    yearsEstimated: 0,
    monthsEstimated: 0,
    birthdateEstimated: false,
    telephoneNumber: '',
    isDead: false,
    deathDate: undefined,
    deathTime: undefined,
    deathTimeFormat: 'AM',
    deathCause: '',
    nonCodedCauseOfDeath: '',
    relationships: [],
    identifiers: {},
    address: {},
  });

  useEffect(() => {
    (async () => {
      if (mpiPatient?.data?.identifier) {
        const identifiers = await getIdentifierFieldValuesFromFhirPatient(
          mpiPatient.data,
          fieldConfigurations.identifierMappings,
        );

        const values = {
          ...initialMPIFormValues,
          ...getFormValuesFromFhirPatient(mpiPatient.data),
          address: getAddressFieldValuesFromFhirPatient(mpiPatient.data),
          identifiers,
          attributes: getPhonePersonAttributeValueFromFhirPatient(
            mpiPatient.data,
            fieldConfigurations.phone.personAttributeUuid,
          ),
        };
        setInitialMPIFormValues(values);
      }
    })();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mpiPatient, isLoadingMpiPatient]);

  return [initialMPIFormValues, setInitialMPIFormValues];
}

export function useInitialAddressFieldValues(patientUuid: string, fallback = {}): [object, Dispatch<object>] {
  const { isLoading, patient } = usePatient(patientUuid);
  const [initialAddressFieldValues, setInitialAddressFieldValues] = useState<object>(fallback);

  useEffect(() => {
    (async () => {
      if (patient) {
        setInitialAddressFieldValues({
          ...initialAddressFieldValues,
          address: getAddressFieldValuesFromFhirPatient(patient),
        });
      } else if (!isLoading && patientUuid) {
        const registration = await getPatientRegistration(patientUuid);
        setInitialAddressFieldValues(registration?._patientRegistrationData.initialAddressFieldValues ?? fallback);
      }
    })();
  }, [fallback, initialAddressFieldValues, isLoading, patient, patientUuid]);

  return [initialAddressFieldValues, setInitialAddressFieldValues];
}

export function usePatientUuidMap(
  patientUuid: string,
  fallback: PatientUuidMapType = {},
): [PatientUuidMapType, Dispatch<PatientUuidMapType>] {
  const { isLoading: isLoadingPatientToEdit, patient: patientToEdit } = usePatient(patientUuid);
  const { data: attributes } = useInitialPersonAttributes(patientUuid);
  const [patientUuidMap, setPatientUuidMap] = useState(fallback);

  useEffect(() => {
    if (patientToEdit) {
      setPatientUuidMap({ ...patientUuidMap, ...getPatientUuidMapFromFhirPatient(patientToEdit) });
    } else if (!isLoadingPatientToEdit && patientUuid) {
      getPatientRegistration(patientUuid).then((registration) =>
        setPatientUuidMap(registration?._patientRegistrationData.initialAddressFieldValues ?? fallback),
      );
    }
  }, [fallback, isLoadingPatientToEdit, patientToEdit, patientUuid, patientUuidMap]);

  useEffect(() => {
    if (attributes) {
      setPatientUuidMap((prevPatientUuidMap) => ({
        ...prevPatientUuidMap,
        ...getPatientAttributeUuidMapForPatient(attributes),
      }));
    }
  }, [attributes]);

  return [patientUuidMap, setPatientUuidMap];
}

async function getPatientRegistration(patientUuid: string) {
  const items = await getSynchronizationItems<PatientRegistration>(patientRegistration);
  return items.find((item) => item._patientRegistrationData.formValues.patientUuid === patientUuid);
}

export function useInitialPatientIdentifiers(patientUuid: string): {
  data: FormValues['identifiers'];
  isLoading: boolean;
} {
  const shouldFetch = !!patientUuid;

  const { data, error, isLoading } = useSWR<FetchResponse<{ results: Array<PatientIdentifierResponse> }>, Error>(
    shouldFetch
      ? `${restBaseUrl}/patient/${patientUuid}/identifier?v=custom:(uuid,identifier,identifierType:(uuid,required,name),preferred)`
      : null,
    openmrsFetch,
  );

  const result: {
    data: FormValues['identifiers'];
    isLoading: boolean;
  } = useMemo(() => {
    const identifiers: FormValues['identifiers'] = {};

    data?.data?.results?.forEach((patientIdentifier) => {
      identifiers[camelCase(patientIdentifier.identifierType.name)] = {
        identifierUuid: patientIdentifier.uuid,
        preferred: patientIdentifier.preferred,
        initialValue: patientIdentifier.identifier,
        identifierValue: patientIdentifier.identifier,
        identifierTypeUuid: patientIdentifier.identifierType.uuid,
        identifierName: patientIdentifier.identifierType.name,
        required: patientIdentifier.identifierType.required,
        selectedSource: null,
        autoGeneration: false,
      };
    });
    return {
      data: identifiers,
      isLoading,
    };
  }, [data?.data?.results, isLoading]);

  return result;
}

function useInitialEncounters(patientUuid: string, patientToEdit: fhir.Patient) {
  const { registrationObs } = useConfig() as RegistrationConfig;
  const { data, error, isLoading } = useSWR<FetchResponse<{ results: Array<Encounter> }>>(
    patientToEdit && registrationObs.encounterTypeUuid
      ? `${restBaseUrl}/encounter?patient=${patientUuid}&v=custom:(encounterDatetime,obs:(concept:ref,value:ref))&encounterType=${registrationObs.encounterTypeUuid}`
      : null,
    openmrsFetch,
  );
  const obs = data?.data.results.sort(latestFirstEncounter)?.at(0)?.obs;
  const encounters = obs
    ?.map(({ concept, value }) => ({
      [(concept as OpenmrsResource).uuid]: typeof value === 'object' ? value?.uuid : value,
    }))
    .reduce((accu, curr) => Object.assign(accu, curr), {});

  return { data: encounters, isLoading, error };
}

function useInitialPersonAttributes(personUuid: string) {
  const shouldFetch = !!personUuid;
  const { data, error, isLoading } = useSWR<FetchResponse<{ results: Array<PersonAttributeResponse> }>, Error>(
    shouldFetch
      ? `${restBaseUrl}/person/${personUuid}/attribute?v=custom:(uuid,display,attributeType:(uuid,display,format),value)`
      : null,
    openmrsFetch,
  );
  const result = useMemo(() => {
    return {
      data: data?.data?.results,
      isLoading,
    };
  }, [data?.data?.results, isLoading]);
  return result;
}

function useInitialPersonDeathInfo(personUuid: string) {
  const { data, error, isLoading } = useSWR<FetchResponse<DeathInfoResults>, Error>(
    !!personUuid
      ? `${restBaseUrl}/person/${personUuid}?v=custom:(uuid,display,causeOfDeath,dead,deathDate,causeOfDeathNonCoded)`
      : null,
    openmrsFetch,
  );

  const result = useMemo(() => {
    return {
      data: data?.data,
      isLoading,
    };
  }, [data?.data, isLoading]);
  return result;
}

function getPatientAttributeUuidMapForPatient(attributes: Array<PersonAttributeResponse>) {
  const attributeUuidMap = {};
  attributes.forEach((attribute) => {
    attributeUuidMap[`attribute.${attribute?.attributeType?.uuid}`] = attribute?.uuid;
  });
  return attributeUuidMap;
}
